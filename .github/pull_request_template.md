## Description

<!-- Clear description of what this PR does -->

## Motivation

<!-- Why is this change needed? What problem does it solve? -->

Fixes # <!-- Issue number, if applicable -->

## Changes

<!-- What was modified? List key changes -->

- 
- 
- 

## Type of Change

<!-- Check all that apply -->

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature causing existing functionality to change)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] Performance improvement
- [ ] Test coverage improvement
- [ ] CI/CD or tooling change

## Testing

### How was this tested?

<!-- Describe testing approach -->

- [ ] Manual testing (describe below)
- [ ] Automated tests added/updated
- [ ] Tested in development environment
- [ ] Tested in production-like environment

**Manual testing steps:**
1. 
2. 
3. 

**Test configuration used:**
```json
{
  "string": "$title - $link",
  ...
}
```

### Test Coverage

- [ ] New code has tests
- [ ] Existing tests pass
- [ ] Test coverage maintained or improved

**Test results:**
```bash
# Paste yarn test output
```

## Modes Tested

<!-- Which modes were tested? -->

- [ ] Single-bot mode (`yarn start`)
- [ ] Fleet mode (`yarn fleet`)
- [ ] Both modes
- [ ] N/A (documentation/tooling only)

## Deployment

### Platform Testing

<!-- Which platforms were tested? Check all that apply -->

- [ ] Docker (local)
- [ ] Fly.io
- [ ] Railway
- [ ] Render
- [ ] Manual/development
- [ ] Not applicable

### Breaking Changes

<!-- Does this PR introduce breaking changes? -->

- [ ] No breaking changes
- [ ] Breaking changes (describe below)

**If breaking:**

**What breaks:**
<!-- What existing functionality changes? -->

**Migration path:**
<!-- How should users update? -->

**Deprecation timeline:**
<!-- When will old behavior be removed? -->

## Configuration Changes

<!-- Does this PR change config.json schema? -->

- [ ] No configuration changes
- [ ] New optional config fields (backward compatible)
- [ ] New required config fields (breaking change)
- [ ] Changed config field behavior (breaking change)
- [ ] Removed config fields (breaking change)

**If config changes:**

**New/changed fields:**
```json
{
  "newField": "default-value"
}
```

**Documentation updated:**
- [ ] README.md config section
- [ ] CONFIGURATION.md reference
- [ ] config.example.json

## Documentation

<!-- Check all documentation that was updated -->

- [ ] Code comments (for complex logic)
- [ ] README.md
- [ ] CONTRIBUTING.md
- [ ] TESTING.md
- [ ] CONFIGURATION.md
- [ ] TROUBLESHOOTING.md
- [ ] FAQ.md
- [ ] EXAMPLES.md
- [ ] ARCHITECTURE.md
- [ ] CHANGELOG.md
- [ ] No documentation needed (explain why below)

**If no documentation:**
<!-- Why doesn't this need documentation? -->

## Checklist

<!-- Verify before requesting review -->

### Code Quality

- [ ] Code follows project style guide (gts)
- [ ] Ran `yarn gts check` (no errors)
- [ ] No new linter warnings introduced
- [ ] Code is self-documenting or has comments explaining "why"
- [ ] No console.log() debug statements left in code
- [ ] Error handling is appropriate
- [ ] No security vulnerabilities introduced

### Testing

- [ ] Ran `yarn test` (all tests pass)
- [ ] Ran `yarn typecheck` (no type errors)
- [ ] Manually tested the changes
- [ ] Tested edge cases and error scenarios
- [ ] Verified backward compatibility (if applicable)

### Repository

- [ ] Branch is up to date with main
- [ ] Commits are logical and have clear messages
- [ ] No merge commits (rebased if needed)
- [ ] No unnecessary files included (node_modules, .env, etc.)

### Deployment (if applicable)

- [ ] Tested in Docker container
- [ ] Health check endpoint works
- [ ] Environment variables documented
- [ ] Volume mounts verified
- [ ] Deployment docs updated if needed

## Screenshots / Logs

<!-- If applicable, add screenshots or log output -->

**Before:**
```
```

**After:**
```
```

## Performance Impact

<!-- Does this change affect performance? -->

- [ ] No performance impact
- [ ] Performance improved (describe below)
- [ ] Potential performance regression (describe below and justify)

**If performance impact:**
<!-- Describe impact, include benchmarks if available -->

## Security Considerations

<!-- Does this PR have security implications? -->

- [ ] No security implications
- [ ] Security improvement (describe below)
- [ ] Potential security concern (describe below)

**If security relevant:**
<!-- Describe security considerations, threat model, mitigations -->

## Dependencies

<!-- Does this PR add, remove, or update dependencies? -->

- [ ] No dependency changes
- [ ] Added new dependencies (list below)
- [ ] Updated existing dependencies
- [ ] Removed dependencies

**If dependencies changed:**

**Added:**
- `package-name@version` - reason for adding

**Updated:**
- `package-name`: `old-version` → `new-version` - reason for update

**Removed:**
- `package-name` - reason for removal

**Dependency audit:**
- [ ] Ran `yarn audit` (no high/critical vulnerabilities)
- [ ] New dependencies reviewed for security
- [ ] License compatibility verified (MIT-compatible)

## Rollback Plan

<!-- How to rollback if this causes issues in production? -->

**If issues arise:**
1. 
2. 
3. 

## Additional Notes

<!-- Any other context, concerns, or questions for reviewers -->

---

## Reviewer Checklist

<!-- For maintainers reviewing this PR -->

- [ ] Code changes reviewed and approved
- [ ] Tests are adequate
- [ ] Documentation is complete
- [ ] No security concerns
- [ ] Breaking changes are justified and documented
- [ ] CHANGELOG.md will be updated (if merging)
