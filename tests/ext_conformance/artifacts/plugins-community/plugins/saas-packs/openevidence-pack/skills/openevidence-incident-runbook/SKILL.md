---
name: openevidence-incident-runbook
description: |
  Execute OpenEvidence incident response procedures with triage, mitigation, and postmortem.
  Use when responding to OpenEvidence-related outages, investigating errors,
  or running post-incident reviews for clinical AI integration failures.
  Trigger with phrases like "openevidence incident", "openevidence outage",
  "openevidence down", "openevidence emergency", "clinical ai broken".
allowed-tools: Read, Grep, Bash(kubectl:*), Bash(curl:*)
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# OpenEvidence Incident Runbook

## Overview
Rapid incident response procedures for OpenEvidence clinical AI integration outages in healthcare environments.

## Prerequisites
- Access to OpenEvidence status page
- kubectl access to production cluster
- Prometheus/Grafana access
- PagerDuty or on-call system access
- Communication channels (Slack, Teams)

## Severity Levels

| Level | Definition | Response Time | Impact | Examples |
|-------|------------|---------------|--------|----------|
| P1 | Complete outage | < 15 min | Patient care affected | API unreachable, all queries failing |
| P2 | Degraded service | < 1 hour | Clinical workflows slowed | High latency, partial failures |
| P3 | Minor impact | < 4 hours | Non-critical features | DeepConsult delays, webhook issues |
| P4 | No user impact | Next business day | Monitoring gaps | Alert noise, logging issues |

## Critical Note: Clinical Impact

**OpenEvidence outages may affect clinical decision-making. Always:**
1. Communicate clearly with clinical staff about degraded service
2. Ensure fallback procedures are known (manual guidelines lookup)
3. Never claim the system is available if it's degraded
4. Document any clinical impact for post-incident review

## Quick Triage

### Step 1: Initial Assessment (2 minutes)
```bash
# 1. Check OpenEvidence status
curl -sf https://status.openevidence.com/api/v2/summary.json | jq '.status'

# 2. Check our integration health
curl -sf https://api.yourhealthcare.com/health/openevidence | jq

# 3. Check error rate (last 5 min)
curl -s 'localhost:9090/api/v1/query?query=rate(openevidence_errors_total[5m])' | jq '.data.result[0].value[1]'

# 4. Recent error logs
kubectl logs -l app=clinical-evidence-api --since=5m | grep -i error | tail -20
```

### Step 2: Decision Tree
```
OpenEvidence API returning errors?
├─ YES: Is status.openevidence.com showing incident?
│   ├─ YES → OpenEvidence outage. Enable fallback. Wait for resolution.
│   └─ NO → Our integration issue. Check credentials, config, network.
└─ NO: Is our service healthy?
    ├─ YES → Likely resolved or intermittent. Monitor closely.
    └─ NO → Our infrastructure issue. Check pods, memory, network.
```

## Incident Response by Error Type

### 401/403 - Authentication Errors
```bash
# Verify API key is set
kubectl get secret openevidence-secrets -o jsonpath='{.data.api-key}' | base64 -d | wc -c

# Check if key format is correct (should start with oe_)
kubectl get secret openevidence-secrets -o jsonpath='{.data.api-key}' | base64 -d | head -c 3

# REMEDIATION: Rotate API key
# 1. Generate new key in OpenEvidence dashboard
# 2. Update secret
kubectl create secret generic openevidence-secrets \
  --from-literal=api-key=NEW_KEY \
  --from-literal=org-id=EXISTING_ORG_ID \
  --dry-run=client -o yaml | kubectl apply -f -

# 3. Restart pods to pick up new secret
kubectl rollout restart deployment/clinical-evidence-api
```

### 429 - Rate Limited
```bash
# Check current rate limit status
curl -s -H "Authorization: Bearer ${OPENEVIDENCE_API_KEY}" \
  https://api.openevidence.com/v1/rate-limit | jq

# Check rate limit metrics
curl -s 'localhost:9090/api/v1/query?query=openevidence_rate_limit_remaining' | jq

# REMEDIATION: Enable request queuing
kubectl set env deployment/clinical-evidence-api RATE_LIMIT_MODE=queue

# Long-term: Contact OpenEvidence for limit increase
# Enterprise: sales@openevidence.com
```

### 500/503 - OpenEvidence Server Errors
```bash
# Confirm it's OpenEvidence-side
curl -v -H "Authorization: Bearer ${OPENEVIDENCE_API_KEY}" \
  https://api.openevidence.com/health 2>&1 | grep "< HTTP"

# REMEDIATION: Enable graceful degradation
kubectl set env deployment/clinical-evidence-api OPENEVIDENCE_FALLBACK=true

# Notify clinical staff
./scripts/notify-clinical-degraded.sh

# Update status page
./scripts/update-status-page.sh degraded "OpenEvidence service degraded"
```

### Timeout Errors
```bash
# Check current timeout setting
kubectl get deployment clinical-evidence-api -o jsonpath='{.spec.template.spec.containers[0].env}' | jq '.[] | select(.name=="OPENEVIDENCE_TIMEOUT")'

# Check network latency to OpenEvidence
time curl -sf https://api.openevidence.com/health

# REMEDIATION: Increase timeout temporarily
kubectl set env deployment/clinical-evidence-api OPENEVIDENCE_TIMEOUT=60000

# Check for network issues
kubectl exec -it deployment/clinical-evidence-api -- nslookup api.openevidence.com
kubectl exec -it deployment/clinical-evidence-api -- traceroute api.openevidence.com
```

## Fallback Procedures

### Enable Graceful Degradation
```typescript
// When OpenEvidence is unavailable, return helpful fallback
const FALLBACK_RESPONSE = {
  answer: 'Clinical evidence service is temporarily unavailable. ' +
          'Please consult UpToDate, DynaMed, or current clinical guidelines directly.',
  citations: [],
  confidence: 0,
  fallback: true,
  disclaimer: 'This is a fallback response. The AI clinical decision support is currently unavailable.',
};

async function clinicalQueryWithFallback(question: string) {
  try {
    return await openEvidence.query(question);
  } catch (error) {
    // Log for incident tracking
    logger.error({ error, question: '[REDACTED]' }, 'OpenEvidence query failed, using fallback');

    // Alert operations
    await alertOps('OpenEvidence unavailable, fallback active');

    return FALLBACK_RESPONSE;
  }
}
```

### Notify Clinical Staff
```bash
#!/bin/bash
# scripts/notify-clinical-degraded.sh

MESSAGE="[Clinical Alert] AI clinical decision support (OpenEvidence) is experiencing issues.
Please use alternative resources (UpToDate, DynaMed, clinical guidelines) until further notice.
Status updates: https://status.yourhealthcare.com"

# Send to clinical Slack channel
curl -X POST -H 'Content-type: application/json' \
  --data "{\"text\":\"$MESSAGE\"}" \
  "$CLINICAL_SLACK_WEBHOOK"

# Send email to clinical leadership
./scripts/send-clinical-email.sh "$MESSAGE"
```

## Communication Templates

### Internal (Slack/Teams)
```markdown
:red_circle: **P1 INCIDENT: OpenEvidence Clinical AI**
**Status:** INVESTIGATING
**Started:** [timestamp]
**Impact:** Clinical queries returning errors/degraded
**Current Action:** [What you're doing]
**Fallback:** Graceful degradation enabled
**Next Update:** [time]
**Incident Commander:** @[name]
```

### External (Clinical Staff)
```markdown
**Clinical Decision Support Alert**

Our AI-powered clinical evidence tool (OpenEvidence) is currently experiencing issues.

**Impact:** Clinical queries may be slower or unavailable
**Alternative Resources:**
- UpToDate: uptodate.com
- DynaMed: dynamed.com
- Clinical guidelines directly

We are actively working to restore service and will provide updates.

Last Updated: [timestamp]
```

### Status Page
```markdown
**OpenEvidence Integration Issue**

We're experiencing issues with our clinical AI integration.
Some clinical evidence queries may be slow or unavailable.

**Impact:** [Specific impact]
**Workaround:** Use alternative clinical resources

We're actively investigating and will provide updates.

Last Updated: [timestamp]
```

## Post-Incident Procedures

### Evidence Collection
```bash
#!/bin/bash
# scripts/collect-incident-evidence.sh

INCIDENT_ID=${1:-$(date +%Y%m%d-%H%M)}
OUTPUT_DIR="incidents/${INCIDENT_ID}"
mkdir -p "$OUTPUT_DIR"

# Export logs (last 2 hours)
kubectl logs -l app=clinical-evidence-api --since=2h > "$OUTPUT_DIR/app-logs.txt"

# Export metrics
curl "localhost:9090/api/v1/query_range?query=openevidence_errors_total&start=$(date -d '2 hours ago' +%s)&end=$(date +%s)&step=60" > "$OUTPUT_DIR/error-metrics.json"
curl "localhost:9090/api/v1/query_range?query=openevidence_request_duration_seconds&start=$(date -d '2 hours ago' +%s)&end=$(date +%s)&step=60" > "$OUTPUT_DIR/latency-metrics.json"

# Export alerts
curl "localhost:9093/api/v2/alerts" > "$OUTPUT_DIR/alerts.json"

# Sanitize (remove any PHI)
./scripts/sanitize-incident-data.sh "$OUTPUT_DIR"

echo "Evidence collected in $OUTPUT_DIR"
```

### Postmortem Template
```markdown
## Incident Postmortem: OpenEvidence [Error Type]

**Date:** YYYY-MM-DD
**Duration:** X hours Y minutes
**Severity:** P[1-4]
**Incident Commander:** [Name]

### Summary
[1-2 sentence description of what happened]

### Clinical Impact
- Queries affected: [number]
- Users impacted: [number]
- Fallback used: Yes/No
- Any patient care impact: [description or "None identified"]

### Timeline (UTC)
| Time | Event |
|------|-------|
| HH:MM | First alert fired |
| HH:MM | Incident declared |
| HH:MM | Fallback enabled |
| HH:MM | Root cause identified |
| HH:MM | Fix deployed |
| HH:MM | Service restored |
| HH:MM | Incident closed |

### Root Cause
[Technical explanation of what caused the incident]

### Contributing Factors
- [Factor 1]
- [Factor 2]

### What Went Well
- [Positive outcome 1]
- [Positive outcome 2]

### What Could Be Improved
- [Improvement area 1]
- [Improvement area 2]

### Action Items
| Action | Owner | Due Date | Status |
|--------|-------|----------|--------|
| [Preventive measure] | [Name] | [Date] | Pending |
| [Detection improvement] | [Name] | [Date] | Pending |

### Lessons Learned
[Key takeaways for the team]
```

## Quick Reference Commands

```bash
# One-line health check
curl -sf https://api.yourhealthcare.com/health/openevidence | jq '.status' || echo "UNHEALTHY"

# Check OpenEvidence status
curl -sf https://status.openevidence.com/api/v2/summary.json | jq '.status.indicator'

# Error rate last 5 min
curl -s 'localhost:9090/api/v1/query?query=rate(openevidence_errors_total[5m])/rate(openevidence_requests_total[5m])*100' | jq '.data.result[0].value[1]'

# Enable fallback mode
kubectl set env deployment/clinical-evidence-api OPENEVIDENCE_FALLBACK=true

# Disable fallback mode (restore normal operation)
kubectl set env deployment/clinical-evidence-api OPENEVIDENCE_FALLBACK=false

# Restart pods
kubectl rollout restart deployment/clinical-evidence-api

# Watch pod status
kubectl get pods -l app=clinical-evidence-api -w
```

## Output
- Quick triage procedure completed
- Issue identified and categorized
- Remediation applied
- Clinical staff notified
- Evidence collected for postmortem

## Resources
- [OpenEvidence Status](https://status.openevidence.com/)
- [OpenEvidence Support](mailto:support@openevidence.com)
- Internal: [On-Call Runbook](internal-link)
- Internal: [Escalation Matrix](internal-link)

## Next Steps
For PHI data handling, see `openevidence-data-handling`.
