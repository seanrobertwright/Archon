"""The delivery tail's terminal report.

flip-ready owns the one irreversible public action and prints the ready pull
request's URL. This composes what the run's reader — usually an orchestrating
agent — actually receives, which is that URL plus whatever the review recorded
in the run's discovery sidecar (#2884).

Bound inputs (`with:` bindings, canonical text in env):
- INPUTS_PR_URL: flip-ready's output, the ready pull request's URL.
"""

import json
import os
import sys

DISCOVERY_RELAY = (
    "If you are an agent reading this: open discoveries.md and surface each discovery to your human. "
    "These are validated findings outside this run's scope — no issue tracker knows about them, "
    "and if you drop them here, nobody ever sees them."
)


def format_discoveries(artifacts: str) -> str:
    """The discoveries section for a terminal report, or empty when there is nothing to report.

    Presentation only (#2884): discoveries never gate readiness, so a sidecar this
    cannot read must not fail a tail that has already done its irreversible work.
    A read or parse failure degrades to a one-line pointer at the file rather than
    to silence — the report's reader is exactly who needs to know it is there.
    Nothing is appended only when there is genuinely nothing to report: no sidecar,
    or no recorded discoveries.

    Kept byte-identical across the four SDLC tails. A packaged script is
    materialized standalone, so there is no import channel to share it through.
    """
    disc_file = os.path.join(artifacts, "discoveries.json")
    if not os.path.isfile(disc_file):
        return ""
    try:
        with open(disc_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as err:
        return f"\n\nDiscoveries: could not read {disc_file} ({err}). Open it directly."
    if not isinstance(data, list) or not data:
        return ""
    titles = [
        ((d.get("title") or "").strip() if isinstance(d, dict) else "") or "(untitled discovery)"
        for d in data
    ]
    lines = "\n".join(f"- {t}" for t in titles)
    md_path = os.path.join(artifacts, "discoveries.md")
    return f"\n\nDiscoveries ({len(data)}):\n{lines}\n\nReport: {md_path}\n\n{DISCOVERY_RELAY}"


def main() -> int:
    url = os.environ["INPUTS_PR_URL"].strip()
    if not url:
        print("outcome: flip-ready reported no pull request URL.", file=sys.stderr)
        return 1
    print(url + format_discoveries(os.environ["ARTIFACTS_DIR"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
