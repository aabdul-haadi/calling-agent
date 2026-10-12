import sys
from pathlib import Path

# Make `app` and `evalab` importable when running pytest from the voice-service folder.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
