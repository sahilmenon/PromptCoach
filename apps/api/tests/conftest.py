import sys
from pathlib import Path

# Ensure apps/api is on sys.path when running pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
