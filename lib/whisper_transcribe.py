import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("--model", default="base")
    args = parser.parse_args()

    try:
        import whisper
    except Exception as exc:
        raise RuntimeError(
            "Whisper not installed. Run: python -m pip install openai-whisper"
        ) from exc

    model = whisper.load_model(args.model)
    result = model.transcribe(
        args.audio_path, language=None, fp16=False, word_timestamps=True, verbose=False
    )

    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            text = (w.get("word") or "").strip()
            if not text:
                continue
            words.append(
                {
                    "text": text,
                    "start": round(float(w.get("start", 0.0)), 3),
                    "end": round(float(w.get("end", 0.0)), 3),
                }
            )

    out = {
        "text": result.get("text", "").strip(),
        "words": words,
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
