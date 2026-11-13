"""Opt-in independent full-file oracle. Uses only an isolated pinned verification wheel."""
import base64
import io
import json
import sys
sys.path.insert(0, sys.argv[1])
from PIL import Image, features, __version__
result = {"pillow": __version__, "libwebp": features.version("webp"), "cases": []}
for case in json.load(sys.stdin):
    with Image.open(io.BytesIO(base64.b64decode(case["bytes"]))) as image:
        frames = []
        for index in range(image.n_frames):
            image.seek(index)
            image.load()
            rgba = image.convert("RGBA")
            frames.append({"width": image.width, "height": image.height,
                           "timestamp": image.info["timestamp"], "duration": image.info["duration"],
                           "rgba": list(rgba.tobytes())})
            rgba.close()
        result["cases"].append({"name": case["name"], "count": image.n_frames,
                                "plays": image.info["loop"], "frames": frames})
json.dump(result, sys.stdout)
