#!/usr/bin/env bash

set -euo pipefail

MODEL=""
SANDBOX="read-only"
WORKDIR="$PWD"
PROMPT=""
PROMPT_FILE=""
OUTPUT_FILE=""
USE_USER_CONFIG=0
ALLOW_DIRTY=0

usage() {
  printf '%s\n' \
    'Usage: scripts/codex-worker.sh --model MODEL [options]' \
    '' \
    'Options:' \
    '  --model MODEL        Required Codex model slug.' \
    '  --sandbox MODE       read-only or workspace-write (default: read-only).' \
    '  --workdir DIR        Git repository/worktree root (default: current directory).' \
    '  --prompt TEXT        Task prompt.' \
    '  --prompt-file FILE   Read the task prompt from a file.' \
    '  --output FILE        Save the worker final message to FILE.' \
    '  --with-user-config   Load user MCP servers and other user defaults.' \
    '  --allow-dirty        Permit workspace-write in a dirty worktree (unsafe override).' \
    '  -h, --help           Show this help.'
}

while (($#)); do
  case "$1" in
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --sandbox)
      SANDBOX="${2:-}"
      shift 2
      ;;
    --workdir)
      WORKDIR="${2:-}"
      shift 2
      ;;
    --prompt)
      PROMPT="${2:-}"
      shift 2
      ;;
    --prompt-file)
      PROMPT_FILE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_FILE="${2:-}"
      shift 2
      ;;
    --with-user-config)
      USE_USER_CONFIG=1
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$MODEL" ]]; then
  printf 'Missing required --model.\n' >&2
  exit 2
fi

if [[ "$SANDBOX" != "read-only" && "$SANDBOX" != "workspace-write" ]]; then
  printf 'Unsupported sandbox mode: %s\n' "$SANDBOX" >&2
  exit 2
fi

if [[ ! -d "$WORKDIR/.git" && ! -f "$WORKDIR/.git" ]]; then
  printf 'Workdir is not a Git repository or worktree: %s\n' "$WORKDIR" >&2
  exit 2
fi

if [[ "$SANDBOX" == "workspace-write" && "$ALLOW_DIRTY" -eq 0 ]]; then
  if [[ -n "$(git -C "$WORKDIR" status --porcelain)" ]]; then
    printf '%s\n' \
      'Refusing workspace-write in a dirty worktree.' \
      'Create a dedicated clean worktree, or pass --allow-dirty only after reviewing ownership.' >&2
    exit 2
  fi
fi

if [[ -n "$PROMPT_FILE" ]]; then
  if [[ -n "$PROMPT" ]]; then
    printf 'Use either --prompt or --prompt-file, not both.\n' >&2
    exit 2
  fi
  if [[ ! -f "$PROMPT_FILE" ]]; then
    printf 'Prompt file does not exist: %s\n' "$PROMPT_FILE" >&2
    exit 2
  fi
  PROMPT="$(<"$PROMPT_FILE")"
fi

if [[ -z "$PROMPT" ]]; then
  printf 'Missing --prompt or --prompt-file.\n' >&2
  exit 2
fi

AUTH_STATUS="$(env -u OPENAI_API_KEY codex login status 2>&1)" || {
  printf 'Unable to verify Codex authentication:\n%s\n' "$AUTH_STATUS" >&2
  exit 3
}

if [[ "$AUTH_STATUS" != *"Logged in using ChatGPT"* ]]; then
  printf '%s\n' \
    'Codex is not authenticated with ChatGPT; refusing subscription-only worker run.' \
    "$AUTH_STATUS" >&2
  exit 3
fi

CODEX_ARGS=(
  exec
  --ephemeral
  --strict-config
  --model "$MODEL"
  --sandbox "$SANDBOX"
  --cd "$WORKDIR"
)

if [[ "$USE_USER_CONFIG" -eq 0 ]]; then
  CODEX_ARGS+=(--ignore-user-config)
fi

if [[ -n "$OUTPUT_FILE" ]]; then
  CODEX_ARGS+=(--output-last-message "$OUTPUT_FILE")
fi

# This machine uses ChatGPT subscription authentication. Removing an ambient
# API key prevents a child process from silently selecting API-key billing.
env -u OPENAI_API_KEY codex "${CODEX_ARGS[@]}" "$PROMPT"
