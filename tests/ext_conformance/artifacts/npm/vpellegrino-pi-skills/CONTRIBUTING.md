# Contributing

Contributions are welcome! This document explains how to contribute to the pi-skills project.

## Development Workflow

### 1. Fork and Clone

```bash
git clone https://github.com/YOUR_USERNAME/pi-skills.git
cd pi-skills
```

### 2. Create a Branch

```bash
git checkout -b feature/my-skill
```

### 3. Make Changes

Add your skill, extension, theme, or prompt template following the existing patterns.

### 4. Validate Locally

Before pushing, run the validation checks:

```bash
# Validate package.json
npm pack --dry-run

# Test with pi locally
pi -e .

# Or test a specific skill
pi -e ./skills/your-skill
```

### 5. Commit and Push

```bash
git add .
git commit -m "Add my-skill for doing X"
git push origin feature/my-skill
```

### 6. Create Pull Request

Open a pull request on GitHub. The CI pipeline will automatically validate your changes.

## CI/CD Pipeline

This project uses GitHub Actions for continuous integration and deployment.

### Validation Workflow

Runs on every push and pull request to `main`:

- ✅ Validates `package.json` structure
- ✅ Validates all skills have proper `SKILL.md` files
- ✅ Checks skill frontmatter (name, description)
- ✅ Ensures skill names match directory names
- ✅ Validates skill name format (lowercase, hyphens only)
- ✅ Checks description length (max 1024 chars)
- ✅ Validates documentation exists
- ✅ Validates `CHANGELOG.md` format

### Publish Workflow

Runs on every push to `main`:

1. Checks if the version in `package.json` changed
2. If changed:
   - Validates the package
   - Publishes to npm
   - Creates a GitHub release
3. If unchanged:
   - Skips publish (only documentation/content updates)

## Publishing a New Version

To publish a new version to npm:

### 1. Update Version

Edit `package.json` and increment the version:

```json
{
  "version": "1.1.0"
}
```

Use semantic versioning:
- `1.0.0` → `1.0.1` - Bug fix (patch)
- `1.0.0` → `1.1.0` - New feature (minor)
- `1.0.0` → `2.0.0` - Breaking change (major)

### 2. Update CHANGELOG.md

```markdown
## [Unreleased]

### Added
- Your new feature

## [1.1.0] - 2025-02-03

### Added
- Release notes here
```

### 3. Commit and Push

```bash
git add package.json CHANGELOG.md
git commit -m "Bump version to 1.1.0"
git push
```

The CI pipeline will automatically:
- Validate the package
- Publish to npm
- Create a GitHub release

## Adding Content

### Adding a Skill

1. Create a new directory:

```bash
mkdir -p skills/your-skill
```

2. Add `SKILL.md`:
   - Update `name` to match directory
   - Write a clear `description` (when to use it)
   - Document setup and usage

3. Add any scripts or references (optional)

4. Commit and push

### Adding an Extension

1. Create a new extension file:

```bash
touch pi-extensions/your-extension.ts
```

2. Implement the extension (see [EXTENSIONS.md](EXTENSIONS.md))

3. Test locally:

```bash
pi -e ./pi-extensions/your-extension.ts
```

4. Commit and push

### Adding a Theme

1. Create `pi-themes/your-theme.json`

2. Follow the theme specification (see [THEMES.md](THEMES.md))

3. Commit and push

### Adding a Prompt Template

1. Create `prompts/your-template.md`

2. Use `{{variable}}` syntax for placeholders

3. Add frontmatter with name and description

4. Commit and push

## Validation Rules

### Skills

- Must have `SKILL.md` file
- Must have `name` in frontmatter
- Must have `description` in frontmatter
- Name must match directory name
- Name must be lowercase with hyphens only
- Description must be ≤ 1024 characters

### Documentation

Required files:
- `README.md`
- `SKILLS.md`
- `EXTENSIONS.md`
- `THEMES.md`
- `PROMPTS.md`
- `CHANGELOG.md`

`CHANGELOG.md` must have `[Unreleased]` section.

## Code of Conduct

Be respectful and constructive. This is a community project.

## Questions?

Open an issue on GitHub for questions or suggestions.
