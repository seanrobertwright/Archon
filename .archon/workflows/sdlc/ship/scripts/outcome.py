"""One return for every legitimate terminal result of the routed fix chain.

Negative advisory verdicts complete with the report that explains them; delivery
is accepted only when the deliver branch actually ran AND GitHub confirms a
ready (non-draft) pull request.

Bound inputs (`with:` bindings, canonical text in env):
- INPUTS_ROUTE / INPUTS_SUMMARY: triage's verdict.
- INPUTS_DELIVERED: deliver's returned output, or "null" when the deliver
  branch was skipped (no_action, or an advisory stop upstream of the gates).
- INPUTS_GATE_PASSED_{DIRECT,ROOTED,PLANNED}: the spend gates' outputs, "null"
  when a gate was skipped. A passed gate with null delivered means delivery
  STARTED and died mid-flight — never claim the advisory stopped it.
"""

import json
import os
import subprocess
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
    # Windows Python writes stdout in the console code page and rewrites '\n' as
    # '\r\n'. A terminal report is stored, posted to GitHub, and compared byte for
    # byte, so pin one encoding and one line ending on every platform.
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    route = os.environ["INPUTS_ROUTE"]
    summary = os.environ["INPUTS_SUMMARY"]
    delivered = os.environ.get("INPUTS_DELIVERED", "null")
    artifacts = os.environ["ARTIFACTS_DIR"]

    if route == "no_action":
        base = f"No delivery needed: {summary}\nReport: {artifacts}/triage.md"
        print(base + format_discoveries(artifacts))
        return 0

    if delivered == "null":
        gate_passed = any(
            os.environ.get(k, "null") != "null"
            for k in (
                "INPUTS_GATE_PASSED_DIRECT",
                "INPUTS_GATE_PASSED_ROOTED",
                "INPUTS_GATE_PASSED_PLANNED",
            )
        )
        if gate_passed:
            # The advisory work cleared its gate; delivery then died mid-flight.
            # Attributing this to the advisory would be false (run a1da7249:
            # rooted:true, implement produced nothing, assert-changed refused).
            print(
                "outcome: delivery started but did not complete — see the run's "
                "earliest failed delivery node.",
                file=sys.stderr,
            )
            return 1
        if route == "investigate":
            base = (
                "No delivery started: the investigation did not establish a safe "
                f"fix boundary.\nReport: {artifacts}/investigation.md"
            )
            print(base + format_discoveries(artifacts))
            return 0
        if route == "plan":
            base = (
                "No delivery started: planning left a material decision "
                f"unresolved.\nReport: {artifacts}/plan.md"
            )
            print(base + format_discoveries(artifacts))
            return 0
        print(
            f"outcome: route '{route}' skipped delivery without an advisory report to point to.",
            file=sys.stderr,
        )
        return 1

    # Deliver ran: accept only what GitHub confirms (a ready, non-draft PR).
    remote = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    origin_repo = "/".join(
        remote.removesuffix(".git").replace(":", "/").rstrip("/").split("/")[-2:]
    )
    # With --repo, gh disables branch inference and requires an explicit
    # selector (seen red on run 925f6c43); pass the current branch.
    branch = subprocess.run(
        ["git", "branch", "--show-current"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if not branch:
        print("outcome: detached HEAD — cannot resolve the PR branch.", file=sys.stderr)
        return 1
    proc = subprocess.run(
        [
            "gh",
            "pr",
            "view",
            branch,
            "--repo",
            origin_repo,
            "--json",
            "isDraft,url",
            "--jq",
            "select(.isDraft == false) | .url",
        ],
        capture_output=True,
        text=True,
    )
    url = proc.stdout.strip() if proc.returncode == 0 else ""
    if not url:
        print("outcome: delivery did not finish with a ready pull request.", file=sys.stderr)
        return 1
    print(url + format_discoveries(artifacts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
