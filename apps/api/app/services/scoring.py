"""Anti-pattern detectors + InputScore / OutputScore heuristics."""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from app.schemas import Finding, OutputDimensions, ScoreDimensions
from app.services.tokens import count_tokens

# Severity → base penalty applied per hit (capped later per pattern)
SEVERITY_PENALTY = {"low": 8, "medium": 16, "high": 26, "critical": 40}

WEIGHTS = {
    "clarity": 0.25,
    "specificity": 0.25,
    "structure": 0.20,
    "concision": 0.15,
    "context_fit": 0.15,
}

FORMAT_HINTS = re.compile(
    r"(?i)\b(json|yaml|markdown|bullet|bullets|schema|table|csv|"
    r"return\s+only|output\s+format|as\s+a\s+list|```)\b"
)
TASK_VERBS = re.compile(
    r"(?i)\b(write|explain|list|create|fix|refactor|summarize|generate|"
    r"compare|implement|debug|analyze|convert|translate|grade)\b"
)


@dataclass
class PatternDef:
    id: str
    name: str
    severity: str
    suggestion: str
    regexes: list[re.Pattern[str]]
    flags: list[str]


def _rules_path() -> Path:
    # Resolve patterns.yaml in monorepo, local cwd, or Docker image layout.
    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / "packages" / "rules" / "patterns.yaml",  # /app/packages/... in Docker
        here.parents[4] / "packages" / "rules" / "patterns.yaml",  # repo root from apps/api/app/services
        here.parents[3] / "packages" / "rules" / "patterns.yaml",
        Path.cwd() / "packages" / "rules" / "patterns.yaml",
        Path.cwd().parents[1] / "packages" / "rules" / "patterns.yaml",
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


@lru_cache
def load_patterns() -> list[PatternDef]:
    path = _rules_path()
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    patterns: list[PatternDef] = []
    for pid, body in raw.get("patterns", {}).items():
        regexes = [re.compile(r) for r in body.get("regex", [])]
        patterns.append(
            PatternDef(
                id=pid,
                name=body.get("name", pid),
                severity=body.get("severity", "medium"),
                suggestion=body.get("suggestion", ""),
                regexes=regexes,
                flags=list(body.get("flags", [])),
            )
        )
    return patterns


def _sentence_split(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [p.strip() for p in parts if p.strip()]


def _jaccard(a: str, b: str) -> float:
    ta = set(re.findall(r"[a-z0-9]+", a.lower()))
    tb = set(re.findall(r"[a-z0-9]+", b.lower()))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def detect_findings(prompt: str, context: str | None = None) -> list[Finding]:
    """Run rule pack + structural flags; return explainable findings with spans."""
    findings: list[Finding] = []
    text = prompt or ""
    full = text if not context else f"{context}\n{text}"

    for pat in load_patterns():
        hits = 0
        for rx in pat.regexes:
            for m in rx.finditer(text):
                hits += 1
                if hits > 3:
                    break
                findings.append(
                    Finding(
                        id=pat.id,
                        severity=pat.severity,
                        span=[m.start(), m.end()],
                        message=pat.name,
                        suggestion=pat.suggestion,
                    )
                )
            if hits > 3:
                break

        if "redundant_sentences" in pat.flags:
            sents = _sentence_split(text)
            seen_pairs: set[tuple[int, int]] = set()
            for i, s1 in enumerate(sents):
                for j in range(i + 1, len(sents)):
                    if _jaccard(s1, sents[j]) >= 0.72:
                        seen_pairs.add((i, j))
            if seen_pairs:
                findings.append(
                    Finding(
                        id=pat.id,
                        severity=pat.severity,
                        span=[0, min(80, len(text))],
                        message=pat.name,
                        suggestion=pat.suggestion,
                    )
                )

        if "missing_format" in pat.flags:
            # Flag when task-like but no format hints
            if TASK_VERBS.search(text) and not FORMAT_HINTS.search(text) and len(text) > 40:
                findings.append(
                    Finding(
                        id=pat.id,
                        severity=pat.severity,
                        span=[0, min(40, len(text))],
                        message=pat.name,
                        suggestion=pat.suggestion,
                    )
                )

        if "context_dump" in pat.flags:
            ctx = context or ""
            # Large pasted block relative to ask, or explicit dump markers
            if re.search(r"(?i)context\s+dump|lorem ipsum|unrelated", full):
                findings.append(
                    Finding(
                        id=pat.id,
                        severity=pat.severity,
                        span=[0, min(60, len(text))],
                        message=pat.name,
                        suggestion=pat.suggestion,
                    )
                )
            elif ctx and count_tokens(ctx) > max(120, count_tokens(text) * 3):
                findings.append(
                    Finding(
                        id=pat.id,
                        severity=pat.severity,
                        span=[0, min(60, len(text))],
                        message=pat.name,
                        suggestion=pat.suggestion,
                    )
                )
            elif count_tokens(text) > 180 and TASK_VERBS.search(text):
                # Long user message with buried ask
                ask = TASK_VERBS.search(text)
                if ask and ask.start() > len(text) * 0.5:
                    findings.append(
                        Finding(
                            id=pat.id,
                            severity=pat.severity,
                            span=[ask.start(), min(ask.end() + 20, len(text))],
                            message=pat.name,
                            suggestion=pat.suggestion,
                        )
                    )

        if "role_spam" in pat.flags:
            roles = list(re.finditer(r"(?i)you\s+are\s+(?:a\s+|an\s+)?\w+", text))
            if len(roles) >= 2 and not TASK_VERBS.search(text):
                findings.append(
                    Finding(
                        id=pat.id,
                        severity=pat.severity,
                        span=[roles[0].start(), roles[-1].end()],
                        message=pat.name,
                        suggestion=pat.suggestion,
                    )
                )
            elif len(roles) >= 3:
                findings.append(
                    Finding(
                        id=pat.id,
                        severity=pat.severity,
                        span=[roles[0].start(), roles[2].end()],
                        message=pat.name,
                        suggestion=pat.suggestion,
                    )
                )

    # Deduplicate identical pattern+span
    uniq: dict[tuple, Finding] = {}
    for f in findings:
        key = (f.id, f.span[0], f.span[1], f.message)
        uniq[key] = f
    return list(uniq.values())


def _band(score: float) -> str:
    if score < 40:
        return "weak"
    if score < 70:
        return "ok"
    return "strong"


def score_input(prompt: str, context: str | None = None) -> dict[str, Any]:
    """Compute explainable InputScore 0–100 from findings + structure signals."""
    findings = detect_findings(prompt, context)
    dims = {
        "clarity": 100.0,
        "specificity": 100.0,
        "structure": 100.0,
        "concision": 100.0,
        "context_fit": 100.0,
    }

    # Map patterns to dimensions
    dim_map = {
        "P01": ["clarity", "specificity"],
        "P02": ["concision"],
        "P03": ["concision", "clarity"],
        "P04": ["specificity", "structure"],
        "P05": ["clarity", "structure"],
        "P06": ["context_fit", "structure"],
        "P07": ["concision", "clarity"],
        "P08": ["clarity", "specificity"],
        "P09": ["context_fit"],
        "P10": ["concision", "specificity"],
    }

    # Cap penalty per pattern id (strong enough that bloated prompts fall <70)
    per_pattern: dict[str, float] = {}
    for f in findings:
        pen = SEVERITY_PENALTY.get(f.severity, 12)
        per_pattern[f.id] = min(45.0, per_pattern.get(f.id, 0.0) + pen)

    for pid, pen in per_pattern.items():
        for d in dim_map.get(pid, ["clarity"]):
            dims[d] = max(0.0, dims[d] - pen)

    # Bonuses
    if FORMAT_HINTS.search(prompt or ""):
        dims["specificity"] = min(100.0, dims["specificity"] + 8)
        dims["structure"] = min(100.0, dims["structure"] + 6)
    if TASK_VERBS.search(prompt or ""):
        dims["clarity"] = min(100.0, dims["clarity"] + 5)
    if re.search(r"(?m)^(\s*[-*]|\d+\.)\s+", prompt or ""):
        dims["structure"] = min(100.0, dims["structure"] + 8)

    # Ultra-short vague prompts
    if len((prompt or "").strip()) < 12:
        dims["clarity"] = min(dims["clarity"], 25)
        dims["specificity"] = min(dims["specificity"], 20)

    score = sum(dims[k] * WEIGHTS[k] for k in WEIGHTS)
    score = float(max(0, min(100, round(score, 1))))

    return {
        "input_score": score,
        "dimensions": ScoreDimensions(
            clarity=round(dims["clarity"], 1),
            specificity=round(dims["specificity"], 1),
            structure=round(dims["structure"], 1),
            concision=round(dims["concision"], 1),
            context_fit=round(dims["context_fit"], 1),
        ),
        "findings": findings,
        "est_tokens": count_tokens(prompt or "") + count_tokens(context or ""),
        "band": _band(score),
    }


def score_output_heuristic(prompt: str, output: str) -> tuple[float, OutputDimensions]:
    """Heuristic OutputScore when LLM judge is unavailable."""
    out = output or ""
    waste = 100.0
    if re.match(r"(?i)^(sure|certainly|of course|great question|as an ai)", out.strip()):
        waste -= 25
    if len(out) > 2500:
        waste -= 15
    # Repetition
    sents = _sentence_split(out)
    if len(sents) >= 2:
        dup = sum(1 for i in range(len(sents) - 1) if _jaccard(sents[i], sents[i + 1]) > 0.8)
        waste -= min(30, dup * 10)
    waste = max(0.0, waste)

    format_compliance = 80.0
    if FORMAT_HINTS.search(prompt or ""):
        if "json" in (prompt or "").lower():
            format_compliance = 90.0 if "{" in out else 35.0
        elif re.search(r"(?i)bullet|list", prompt or ""):
            format_compliance = 85.0 if re.search(r"(?m)^\s*[-*\d]", out) else 40.0

    specificity = 70.0 if len(out) > 40 else 40.0
    calibration = 70.0
    if re.search(r"(?i)\b(as an ai|i cannot browse)\b", out):
        calibration = 55.0

    # TaskFit unknown without judge
    dims = OutputDimensions(
        task_fit=None,
        specificity=specificity,
        waste=waste,
        format_compliance=format_compliance,
        calibration=calibration,
    )
    # Reweight without task_fit
    score = (
        specificity * 0.30
        + waste * 0.30
        + format_compliance * 0.30
        + calibration * 0.10
    )
    return float(round(max(0, min(100, score)), 1)), dims


def pattern_name(pid: str) -> str:
    for p in load_patterns():
        if p.id == pid:
            return p.name
    return pid
