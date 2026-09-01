"""Route non-introduced late CI red to an explicit operator action."""

import json
import os
import sys


def main() -> int:
    red_cause = os.environ.get("INPUTS_RED_CAUSE", "").strip()
    pr_number = os.environ.get("INPUTS_PR_NUMBER", "").strip()
    if red_cause not in ("", "introduced", "inherited", "environment"):
        print(f"invalid late-CI red cause: {red_cause!r}", file=sys.stderr)
        return 1
    try:
        parsed_pr_number = int(pr_number)
        if parsed_pr_number < 1:
            raise ValueError
    except ValueError:
        print(f"invalid pull request number: {pr_number!r}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "attention": red_cause in ("inherited", "environment"),
                "red_cause": red_cause,
                "pr_number": parsed_pr_number,
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
