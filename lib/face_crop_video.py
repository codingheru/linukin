import argparse
import math
import os
import sys
import time

import cv2
import numpy as np
from insightface.app import FaceAnalysis


MODEL_NAME = os.environ.get("INSIGHTFACE_MODEL", "buffalo_s")
DETECT_SIZE = int(os.environ.get("INSIGHTFACE_DET_SIZE", "512"))
MIN_FACE_SCORE = float(os.environ.get("INSIGHTFACE_MIN_FACE_SCORE", "0.45"))
MIN_FACE_AREA_RATIO = float(os.environ.get("INSIGHTFACE_MIN_FACE_AREA_RATIO", "0.0025"))
MIN_FACE_SHORT_SIDE = int(os.environ.get("INSIGHTFACE_MIN_FACE_SHORT_SIDE", "32"))
MIN_RELATIVE_AREA_TO_MAX = float(
    os.environ.get("INSIGHTFACE_MIN_RELATIVE_AREA_TO_MAX", "0.12")
)


def init_analyzer():
    attempts = [
        (0, ["CUDAExecutionProvider", "CPUExecutionProvider"]),
        (-1, ["CPUExecutionProvider"]),
    ]
    last_error = None
    for ctx_id, providers in attempts:
        try:
            analyzer = FaceAnalysis(
                name=MODEL_NAME,
                providers=providers,
                allowed_modules=["detection"],
            )
            analyzer.prepare(ctx_id=ctx_id, det_size=(DETECT_SIZE, DETECT_SIZE))
            return analyzer
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"InsightFace init failed: {last_error}")


def compute_crop_size(src_w, src_h, target_aspect):
    if src_w / src_h > target_aspect:
        crop_h = src_h
        crop_w = int(round(src_h * target_aspect))
    else:
        crop_w = src_w
        crop_h = int(round(src_w / target_aspect))
    return crop_w, crop_h


def clamp_box(center_x, center_y, crop_w, crop_h, frame_w, frame_h):
    x1 = int(round(center_x - crop_w / 2))
    y1 = int(round(center_y - crop_h / 2))
    x1 = max(0, min(x1, frame_w - crop_w))
    y1 = max(0, min(y1, frame_h - crop_h))
    return {
        "x1": x1,
        "y1": y1,
        "x2": x1 + crop_w,
        "y2": y1 + crop_h,
    }


def crop_frame_region(frame, region):
    x1, y1, x2, y2 = region["x1"], region["y1"], region["x2"], region["y2"]
    return frame[y1:y2, x1:x2].copy()


def fit_to_canvas(src, out_w, out_h, cover=False):
    sh, sw = src.shape[:2]
    if sh <= 0 or sw <= 0:
        return np.zeros((out_h, out_w, 3), dtype=np.uint8)
    scale = max(out_w / sw, out_h / sh) if cover else min(out_w / sw, out_h / sh)
    rw = max(1, int(round(sw * scale)))
    rh = max(1, int(round(sh * scale)))
    resized = cv2.resize(src, (rw, rh), interpolation=cv2.INTER_LINEAR)
    if cover:
        x1 = max(0, (rw - out_w) // 2)
        y1 = max(0, (rh - out_h) // 2)
        return resized[y1 : y1 + out_h, x1 : x1 + out_w].copy()
    canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)
    ox = (out_w - rw) // 2
    oy = (out_h - rh) // 2
    canvas[oy : oy + rh, ox : ox + rw] = resized
    return canvas


def detect_stride(mode, fps, duration):
    if mode == "accurate":
        return 1
    if mode == "balanced":
        return 4
    # fast: stride tidak dipakai untuk tracking — hanya dipakai untuk sample awal
    duration = max(1.0, duration)
    sample_fps = max(0.3, min(fps if fps > 0 else 30.0, 36.0 / duration))
    return max(1, int(math.floor((fps if fps > 0 else 30.0) / sample_fps)))


def detect_face_center_fast(cap, analyzer, frame_w, frame_h, fps, total_frames):
    """
    Fast mode: sample beberapa frame di awal+tengah video, ambil median center wajah.
    Kembalikan (center_x, center_y) yang fixed untuk seluruh video, atau None jika tidak ada wajah.
    """
    n_samples = min(5, max(1, total_frames))
    # Ambil frame di posisi 5%, 20%, 35%, 50%, 65% durasi video
    offsets = [int(total_frames * p) for p in (0.05, 0.20, 0.35, 0.50, 0.65)]
    offsets = [min(max(0, o), total_frames - 1) for o in offsets]

    centers_x, centers_y = [], []
    for offset in offsets:
        cap.set(cv2.CAP_PROP_POS_FRAMES, offset)
        ok, frame = cap.read()
        if not ok:
            continue
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        faces = sorted(analyzer.get(rgb), key=lambda f: float(f.bbox[0]))
        bboxes = filter_faces(faces, frame_w, frame_h)
        if bboxes:
            # Ambil wajah terbesar
            biggest = max(bboxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
            cx = (biggest[0] + biggest[2]) / 2.0
            cy = (biggest[1] + biggest[3]) / 2.0
            centers_x.append(cx)
            centers_y.append(cy)

    # Reset ke awal
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    if not centers_x:
        return None

    # Median center
    centers_x.sort()
    centers_y.sort()
    mid = len(centers_x) // 2
    return centers_x[mid], centers_y[mid]


# EMA (Exponential Moving Average) smoother untuk posisi crop
class PositionEMA:
    def __init__(self, alpha=0.08):
        self.alpha = alpha  # nilai kecil = lebih smooth, lebih lambat ikuti wajah
        self.x = None
        self.y = None

    def update(self, x, y):
        if self.x is None:
            self.x, self.y = x, y
        else:
            self.x = self.alpha * x + (1.0 - self.alpha) * self.x
            self.y = self.alpha * y + (1.0 - self.alpha) * self.y
        return self.x, self.y

    def get(self):
        return self.x, self.y


def filter_faces(raw_faces, frame_w, frame_h):
    frame_area = max(1, frame_w * frame_h)
    candidates = []
    for face in raw_faces:
        score = float(getattr(face, "det_score", 0.0))
        if score < MIN_FACE_SCORE:
            continue
        bbox = np.asarray(face.bbox, dtype=float)
        x1 = int(max(0, bbox[0]))
        y1 = int(max(0, bbox[1]))
        x2 = int(min(frame_w - 1, bbox[2]))
        y2 = int(min(frame_h - 1, bbox[3]))
        w = max(0, x2 - x1)
        h = max(0, y2 - y1)
        if w < MIN_FACE_SHORT_SIDE or h < MIN_FACE_SHORT_SIDE:
            continue
        area = w * h
        if area / frame_area < MIN_FACE_AREA_RATIO:
            continue
        candidates.append({"bbox": [x1, y1, x2, y2], "area": area})

    if len(candidates) <= 1:
        return [c["bbox"] for c in candidates]

    max_area = max(c["area"] for c in candidates)
    rel_threshold = max_area * MIN_RELATIVE_AREA_TO_MAX
    filtered = [c["bbox"] for c in candidates if c["area"] >= rel_threshold]
    if filtered:
        filtered.sort(key=lambda b: b[0])
        return filtered[:2]
    biggest = max(candidates, key=lambda c: c["area"])
    return [biggest["bbox"]]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("target_w", type=int)
    parser.add_argument("target_h", type=int)
    parser.add_argument("--detect-mode", default="balanced")
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {args.input}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = total_frames / fps if fps > 0 and total_frames > 0 else 0
    stride = detect_stride(args.detect_mode, fps, duration)
    target_aspect = args.target_w / args.target_h

    analyzer = init_analyzer()

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(args.output, fourcc, fps, (args.target_w, args.target_h))
    if not writer.isOpened():
        raise RuntimeError(f"Could not open writer: {args.output}")

    crop_w, crop_h = compute_crop_size(frame_w, frame_h, target_aspect)
    last_crop_frame = np.zeros((args.target_h, args.target_w, 3), dtype=np.uint8)
    frame_idx = 0
    detect_hits = 0
    t0 = time.time()

    # ── FAST MODE: deteksi sekali di awal, crop fixed sepanjang video ──────────
    if args.detect_mode == "fast":
        fixed_region = None
        result = detect_face_center_fast(
            cap, analyzer, frame_w, frame_h, fps, total_frames
        )
        detect_hits = 5  # paling banyak 5 sample
        if result is not None:
            cx, cy = result
            fixed_region = clamp_box(cx, cy, crop_w, crop_h, frame_w, frame_h)

        # Reset ke frame 0 dan render semua frame
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if fixed_region is not None:
                cropped = crop_frame_region(frame, fixed_region)
                crop_frame = fit_to_canvas(cropped, args.target_w, args.target_h)
            else:
                # Tidak ada wajah — center crop
                cx = frame_w / 2.0
                cy = frame_h / 2.0
                region = clamp_box(cx, cy, crop_w, crop_h, frame_w, frame_h)
                cropped = crop_frame_region(frame, region)
                crop_frame = fit_to_canvas(cropped, args.target_w, args.target_h)
            writer.write(crop_frame)
            frame_idx += 1

    # ── BALANCED / ACCURATE MODE: tracking dengan EMA smoothing ───────────────
    else:
        # EMA alpha: balanced lebih smooth (0.08), accurate lebih responsif (0.25)
        ema_alpha = 0.08 if args.detect_mode == "balanced" else 0.25
        smoother = PositionEMA(alpha=ema_alpha)
        last_regions = None

        while True:
            ok, frame = cap.read()
            if not ok:
                break

            should_detect = frame_idx % stride == 0 or last_regions is None
            detected_center = None

            if should_detect:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                faces = sorted(analyzer.get(rgb), key=lambda f: float(f.bbox[0]))
                bboxes = filter_faces(faces, frame_w, frame_h)
                face_count = len(bboxes)

                if face_count == 1:
                    x1, y1, x2, y2 = bboxes[0]
                    detected_center = ((x1 + x2) / 2.0, (y1 + y2) / 2.0)
                    last_regions = ("single", detected_center)
                elif face_count >= 2:
                    last_regions = (
                        "dual",
                        {"mid_x": max(1, min(frame_w - 1, frame_w // 2))},
                    )
                detect_hits += 1

            # Tentukan posisi crop untuk frame ini
            crop_frame = None

            if last_regions is not None and last_regions[0] == "single":
                raw_cx, raw_cy = last_regions[1]
                # Update EMA hanya saat ada deteksi baru, pakai last smoothed saat tidak
                if should_detect and detected_center is not None:
                    smooth_cx, smooth_cy = smoother.update(raw_cx, raw_cy)
                else:
                    # Tidak ada deteksi baru → pakai posisi EMA terakhir (tidak loncat)
                    pos = smoother.get()
                    smooth_cx = pos[0] if pos[0] is not None else raw_cx
                    smooth_cy = pos[1] if pos[1] is not None else raw_cy

                region = clamp_box(
                    smooth_cx, smooth_cy, crop_w, crop_h, frame_w, frame_h
                )
                cropped = crop_frame_region(frame, region)
                crop_frame = fit_to_canvas(cropped, args.target_w, args.target_h)

            elif last_regions is not None and last_regions[0] == "dual":
                regions = last_regions[1]
                mid_x = int(regions.get("mid_x", frame_w // 2))
                left_half = frame[:, 0:mid_x]
                right_half = frame[:, mid_x:frame_w]
                half_h = args.target_h // 2
                top = fit_to_canvas(left_half, args.target_w, half_h, cover=True)
                bottom = fit_to_canvas(
                    right_half, args.target_w, args.target_h - half_h, cover=True
                )
                crop_frame = np.concatenate([top, bottom], axis=0)

            if crop_frame is None:
                crop_frame = last_crop_frame
            else:
                last_crop_frame = crop_frame

            writer.write(crop_frame)
            frame_idx += 1

    writer.release()
    cap.release()

    elapsed = time.time() - t0
    print(
        f'{{"frames": {frame_idx}, "fps": {fps:.3f}, "detect_stride": {stride}, "detect_hits": {detect_hits}, "elapsed_sec": {elapsed:.3f}}}'
    )


if __name__ == "__main__":
    main()
