---
name: jira
description: Interact with Jira using the jira-cli tool. Search, create, view, edit, and transition issues; manage epics and sprints; add comments and worklogs. Use when working with Jira tickets, backlogs, or project management tasks.
---

# Jira Skill

Interactive Jira command line tool for managing issues, epics, sprints, and more.

## Setup

### Installation

Install `jira-cli`:

```bash
# macOS (Homebrew)
brew install jira-cli

# Or download from releases
# https://github.com/ankitpokhrel/jira-cli/releases
```

### Configuration

1. Get a Jira API token for Jira Cloud: https://id.atlassian.com/manage-profile/security/api-tokens
2. Export the token:

```bash
export JIRA_API_TOKEN="your-api-token"
```

Add to your shell config (`~/.bashrc`, `~/.zshrc`, etc.) to make it persistent.

3. Initialize jira-cli:

```bash
jira init
```

Follow the prompts to configure:
- Installation type (Cloud or Local)
- Base URL (e.g., `https://yourcompany.atlassian.net`)
- Email/username
- Project key (optional, can be set per command)

For on-premise installations, you may need to set:

```bash
export JIRA_AUTH_TYPE="bearer"  # or "basic"
```

## List Issues

```bash
# List recent issues (interactive)
jira issue list

# List issues created in last 7 days
jira issue list --created -7d

# List issues by status
jira issue list -s "To Do"
jira issue list -s "In Progress"
jira issue list -s "Done"

# List issues by priority
jira issue list --priority High

# List issues by assignee
jira issue list --assignee $(jira me)

# List issues by reporter
jira issue list --reporter $(jira me)

# List issues by label
jira issue list --label backend

# List issues by project
jira issue list --project PROJKEY

# Plain output (non-interactive)
jira issue list --plain

# JSON output (for parsing)
jira issue list --raw

# CSV output
jira issue list --csv

# Complex query: High priority, assigned to me, in To Do, created this month
jira issue list --priority High --assignee $(jira me) -s "To Do" --created month --label backend
```

### Common Filters

| Flag | Description | Example |
|------|-------------|---------|
| `-s, --status` | Filter by status | `-s "In Progress"` |
| `-y, --priority` | Filter by priority | `--priority High` |
| `-l, --label` | Filter by label | `-l backend` |
| `-a, --assignee` | Filter by assignee | `-a $(jira me)` |
| `-r, --reporter` | Filter by reporter | `-r $(jira me)` |
| `--created` | Filter by creation date | `--created -7d`, `--created month` |
| `--updated` | Filter by update date | `--updated -7d` |
| `-p, --project` | Filter by project | `-p PROJKEY` |
| `--type` | Filter by issue type | `--type Bug` |

## View Issues

```bash
# View issue details in terminal
jira issue view ISSUE-123

# View without pager
jira issue view ISSUE-123 --no-pager

# View in browser
jira issue view ISSUE-123 --web
```

## Create Issues

```bash
# Interactive creation (prompts for all fields)
jira issue create

# Create with summary only
jira issue create "Fix login bug"

# Create with type and summary
jira issue create --type Bug "Fix login bug"

# Create with all fields
jira issue create \
  --type Bug \
  --summary "Fix login bug" \
  --description "Users cannot login after update" \
  --priority High \
  --assignee "$(jira me)" \
  --label backend,auth \
  --project PROJKEY
```

## Edit Issues

```bash
# Interactive edit (opens in editor)
jira issue edit ISSUE-123

# Edit summary
jira issue edit ISSUE-123 --summary "New summary"

# Edit description
jira issue edit ISSUE-123 --description "Updated description"

# Edit priority
jira issue edit ISSUE-123 --priority High

# Change assignee
jira issue edit ISSUE-123 --assignee "$(jira me)"

# Add labels
jira issue edit ISSUE-123 --label backend,bug
```

## Transition Issues

```bash
# Interactive transition (choose from available transitions)
jira issue transition ISSUE-123

# Transition to specific status
jira issue transition ISSUE-123 "In Progress"
jira issue transition ISSUE-123 "Done"
jira issue transition ISSUE-123 "In Review"
```

## Comments

```bash
# Add comment
jira issue comment add ISSUE-123 "This needs more testing"

# Add comment with markdown
jira issue comment add ISSUE-123 "**Note:** This is a priority issue."

# List comments
jira issue comment list ISSUE-123

# Edit comment
jira issue comment edit ISSUE-123 "Comment ID" "Updated comment"

# Delete comment
jira issue comment delete ISSUE-123 "Comment ID"
```

## Worklog (Time Tracking)

```bash
# Add worklog
jira issue worklog add ISSUE-123 --time "2h" --message "Fixed the bug"

# Add worklog with specific time
jira issue worklog add ISSUE-123 --time "1d 2h 30m" --message "Implementation"

# List worklogs
jira issue worklog list ISSUE-123

# Delete worklog
jira issue worklog delete ISSUE-123 "Worklog ID"
```

## Epics

```bash
# List epics
jira epic list

# List epics in plain mode
jira epic list --plain

# Create epic
jira epic create \
  --name "Authentication System" \
  --summary "Implement OAuth2 authentication" \
  --description "Add OAuth2 login flow"

# View epic details
jira epic view EPIC-123

# List issues in epic
jira epic list EPIC-123

# Add issues to epic
jira issue edit ISSUE-123 --epic EPIC-123
```

## Sprints

```bash
# List sprints
jira sprint list

# List active sprint issues
jira sprint list --state active

# List issues in sprint
jira sprint list SPRINT-123

# Start sprint
jira sprint start SPRINT-123

# Close sprint
jira sprint close SPRINT-123
```

## Projects

```bash
# List projects
jira project list

# View project details
jira project view PROJKEY
```

## Current User

```bash
# Get current user info
jira me

# Get current user key
jira me --key

# Use in other commands
jira issue list --assignee "$(jira me)"
```

## Search (JQL)

```bash
# Jira Query Language (JQL) search
jira issue list --query "project = PROJKEY AND status = 'In Progress'"

# Complex JQL
jira issue list --query 'project = PROJKEY AND assignee = currentUser() AND priority = High'

# JQL with date range
jira issue list --query "created >= -30d AND project = PROJKEY"
```

## Interactive Navigation

In interactive mode:
- Arrow keys or `j/k/h/l` - Navigate
- `v` - View issue details
- `m` - Transition issue
- `ENTER` - Open in browser
- `c` - Copy issue URL
- `CTRL+k` - Copy issue key
- `CTRL+r` or `F5` - Refresh
- `q` / `ESC` / `CTRL+c` - Quit
- `?` - Help

## Multiple Projects

Use different config files:

```bash
# Use specific config
jira issue list --config ~/jira-configs/project1.yaml

# Or set environment variable
JIRA_CONFIG_FILE=~/jira-configs/project1.yaml jira issue list
```

## Common Workflows

### Get assigned issues for today
```bash
jira issue list --assignee "$(jira me)" -s "In Progress" --created -7d
```

### Review backlog
```bash
jira issue list -s "To Do" --priority High
```

### Get release notes (sprint summary)
```bash
jira sprint list --state closed
jira issue list --sprint SPRINT-123 -s Done
```

### Start work on an issue
```bash
jira issue transition ISSUE-123 "In Progress"
jira issue view ISSUE-123
```

### Complete an issue
```bash
jira issue transition ISSUE-123 "Done"
jira issue worklog add ISSUE-123 --time "1h" --message "Completed task"
```

## Notes

- jira-cli supports both Jira Cloud and Jira Server/Data Center
- For on-premise installations, you may need to use basic auth or PAT
- Time format: `1h` (hour), `1d` (day), `1w` (week), `1m` (month)
- Date filters: `-7d` (7 days ago), `month` (this month), `week` (this week)
- Always use quotes around status names with spaces: `-s "In Progress"`
