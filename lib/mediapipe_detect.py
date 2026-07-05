"""
InsightFace / ArcFace face detection helper.

Kept under the old filename so the Node side does not need major routing changes.

Usage:
    python mediapipe_detect.py image.jpg
    python mediapipe_detect.py --batch paths.json
"""

import json
import os
import sys

import cv2
import numpy as np
from insightface.app import FaceAnalysis


DETECT_SIZE = int(os.environ.get("INSIGHTFACE_DET_SIZE", "512"))
MODEL_NAME = os.environ.get("INSIGHTFACE_MODEL", "buffalo_s")


def _prepare_analyzer(ctx_id, providers):
    analyzer = FaceAnalysis(
        name=MODEL_NAME,
        providers=providers,
        allowed_modules=["detection"],
    )
    analyzer.prepare(ctx_id=ctx_id, det_size=(DETECT_SIZE, DETECT_SIZE))
    return analyzer


def create_detector():
    last_error = None
    attempts = [
        (0, ["CUDAExecutionProvider", "CPUExecutionProvider"]),
        (-1, ["CPUExecutionProvider"]),
    ]
    for ctx_id, providers in attempts:
        try:
            return _prepare_analyzer(ctx_id, providers)
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"InsightFace init failed: {last_error}")


def _normalize_keypoints(face):
    if getattr(face, "kps", None) is None:
        return []
    pts = np.asarray(face.kps, dtype=float)
    return [{"x": round(float(x), 1), "y": round(float(y), 1)} for x, y in pts]


def detect_faces(detector, image_path):
    img = cv2.imread(image_path)
    if img is None:
        return []

    h, w = img.shape[:2]
    faces = []
    for face in detector.get(img):
        bbox = np.asarray(face.bbox, dtype=float)
        x1 = max(0, int(round(bbox[0])))
        y1 = max(0, int(round(bbox[1])))
        x2 = min(w, int(round(bbox[2])))
        y2 = min(h, int(round(bbox[3])))
        fw = max(0, x2 - x1)
        fh = max(0, y2 - y1)
        if fw <= 0 or fh <= 0:
            continue

        item = {
            "x": x1,
            "y": y1,
            "w": fw,
            "h": fh,
            "score": round(float(getattr(face, "det_score", 0.0)), 4),
            "keypoints": _normalize_keypoints(face),
        }

        faces.append(item)

    faces.sort(key=lambda f: (f["x"], f["y"]))
    return faces


def main():
    detector = create_detector()

    if len(sys.argv) > 2 and sys.argv[1] == "--batch":
        with open(sys.argv[2], "r", encoding="utf-8") as f:
            paths = json.load(f)
        results = []
        for p in paths:
            faces = detect_faces(detector, p)
            results.append({"path": p, "faces": faces, "count": len(faces)})
        print(json.dumps(results))
        return

    if len(sys.argv) > 1 and sys.argv[1] != "--batch":
        image_path = sys.argv[1]
        faces = detect_faces(detector, image_path)
        print(json.dumps({"path": image_path, "faces": faces, "count": len(faces)}))
        return


if __name__ == "__main__":
    main()
