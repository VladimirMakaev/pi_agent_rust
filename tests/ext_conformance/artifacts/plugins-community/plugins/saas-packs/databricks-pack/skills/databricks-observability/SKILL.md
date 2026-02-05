---
name: databricks-observability
description: |
  Set up comprehensive observability for Databricks with metrics, traces, and alerts.
  Use when implementing monitoring for Databricks jobs, setting up dashboards,
  or configuring alerting for pipeline health.
  Trigger with phrases like "databricks monitoring", "databricks metrics",
  "databricks observability", "monitor databricks", "databricks alerts", "databricks logging".
allowed-tools: Read, Write, Edit, Bash(databricks:*)
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# Databricks Observability

## Overview
Set up comprehensive observability for Databricks workloads.

## Prerequisites
- Access to system tables
- SQL Warehouse for dashboards
- Notification destinations configured
- Alert recipients defined

## Metrics Collection

### Key Metrics
| Metric | Source | Description |
|--------|--------|-------------|
| Job success rate | system.lakeflow.job_run_timeline | % of successful job runs |
| Job duration | system.lakeflow.job_run_timeline | Run time in minutes |
| Cluster utilization | system.compute.cluster_events | CPU/memory usage |
| Data freshness | table history | Hours since last update |
| DBU consumption | system.billing.usage | Cost tracking |

## Instructions

### Step 1: System Tables Access

```sql
-- Enable system tables (workspace admin)
-- Check available system tables
SELECT * FROM system.information_schema.tables
WHERE table_schema = 'billing' OR table_schema = 'lakeflow';

-- Job run history
SELECT
    job_id,
    job_name,
    run_id,
    start_time,
    end_time,
    result_state,
    error_message,
    (end_time - start_time) / 60000 as duration_minutes
FROM system.lakeflow.job_run_timeline
WHERE start_time > current_timestamp() - INTERVAL 24 HOURS
ORDER BY start_time DESC;

-- Cluster events
SELECT
    cluster_id,
    timestamp,
    type,
    details
FROM system.compute.cluster_events
WHERE timestamp > current_timestamp() - INTERVAL 24 HOURS
ORDER BY timestamp DESC;
```

### Step 2: Create Monitoring Views

```sql
-- Job health summary view
CREATE OR REPLACE VIEW monitoring.job_health_summary AS
SELECT
    job_name,
    COUNT(*) as total_runs,
    SUM(CASE WHEN result_state = 'SUCCESS' THEN 1 ELSE 0 END) as successes,
    SUM(CASE WHEN result_state = 'FAILED' THEN 1 ELSE 0 END) as failures,
    ROUND(SUM(CASE WHEN result_state = 'SUCCESS' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as success_rate,
    AVG((end_time - start_time) / 60000) as avg_duration_minutes,
    PERCENTILE((end_time - start_time) / 60000, 0.95) as p95_duration_minutes,
    MAX(start_time) as last_run_time,
    MAX(CASE WHEN result_state = 'FAILED' THEN start_time END) as last_failure_time
FROM system.lakeflow.job_run_timeline
WHERE start_time > current_timestamp() - INTERVAL 7 DAYS
GROUP BY job_name;

-- Data freshness view
CREATE OR REPLACE VIEW monitoring.data_freshness AS
SELECT
    table_catalog,
    table_schema,
    table_name,
    MAX(commit_timestamp) as last_update,
    TIMESTAMPDIFF(HOUR, MAX(commit_timestamp), current_timestamp()) as hours_since_update,
    CASE
        WHEN TIMESTAMPDIFF(HOUR, MAX(commit_timestamp), current_timestamp()) < 1 THEN 'FRESH'
        WHEN TIMESTAMPDIFF(HOUR, MAX(commit_timestamp), current_timestamp()) < 6 THEN 'RECENT'
        WHEN TIMESTAMPDIFF(HOUR, MAX(commit_timestamp), current_timestamp()) < 24 THEN 'STALE'
        ELSE 'VERY_STALE'
    END as freshness_status
FROM system.information_schema.table_history
GROUP BY table_catalog, table_schema, table_name;

-- Cost tracking view
CREATE OR REPLACE VIEW monitoring.daily_costs AS
SELECT
    DATE(usage_date) as date,
    workspace_id,
    sku_name,
    usage_type,
    SUM(usage_quantity) as total_dbus,
    SUM(usage_quantity * list_price) as estimated_cost
FROM system.billing.usage
WHERE usage_date > current_date() - INTERVAL 30 DAYS
GROUP BY DATE(usage_date), workspace_id, sku_name, usage_type
ORDER BY date DESC, estimated_cost DESC;
```

### Step 3: Configure Alerts

```sql
-- Alert: Job failure
CREATE ALERT job_failure_alert
AS SELECT
    job_name,
    run_id,
    error_message,
    start_time
FROM system.lakeflow.job_run_timeline
WHERE result_state = 'FAILED'
  AND start_time > current_timestamp() - INTERVAL 15 MINUTES
SCHEDULE CRON '*/15 * * * *'
NOTIFICATIONS (
    email_addresses = ['oncall@company.com'],
    webhook_destinations = ['slack-alerts']
);

-- Alert: Long-running jobs
CREATE ALERT long_running_job_alert
AS SELECT
    job_name,
    run_id,
    start_time,
    TIMESTAMPDIFF(MINUTE, start_time, current_timestamp()) as running_minutes
FROM system.lakeflow.job_run_timeline
WHERE end_time IS NULL
  AND TIMESTAMPDIFF(MINUTE, start_time, current_timestamp()) > 120
SCHEDULE CRON '*/30 * * * *'
NOTIFICATIONS (
    email_addresses = ['oncall@company.com']
);

-- Alert: Data freshness SLA breach
CREATE ALERT data_freshness_sla
AS SELECT
    table_name,
    hours_since_update
FROM monitoring.data_freshness
WHERE table_schema = 'gold'
  AND hours_since_update > 6
SCHEDULE CRON '0 * * * *'
NOTIFICATIONS (
    email_addresses = ['data-team@company.com']
);

-- Alert: Cost spike
CREATE ALERT daily_cost_spike
AS SELECT
    date,
    estimated_cost,
    LAG(estimated_cost) OVER (ORDER BY date) as prev_day_cost,
    (estimated_cost - LAG(estimated_cost) OVER (ORDER BY date)) /
        NULLIF(LAG(estimated_cost) OVER (ORDER BY date), 0) * 100 as percent_change
FROM monitoring.daily_costs
WHERE date = current_date() - 1
HAVING percent_change > 50  -- 50% increase
SCHEDULE CRON '0 8 * * *'
NOTIFICATIONS (
    email_addresses = ['finops@company.com']
);
```

### Step 4: Structured Logging

```python
# src/utils/logging.py
import logging
import json
from datetime import datetime
from typing import Any

class StructuredLogger:
    """Structured logging for Databricks notebooks."""

    def __init__(self, job_name: str, run_id: str = None):
        self.job_name = job_name
        self.run_id = run_id or str(datetime.now().timestamp())
        self.logger = logging.getLogger(job_name)
        self.logger.setLevel(logging.INFO)

        # JSON formatter
        handler = logging.StreamHandler()
        handler.setFormatter(JsonFormatter())
        self.logger.addHandler(handler)

    def _log(self, level: str, message: str, **context):
        """Log with structured context."""
        log_entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "job_name": self.job_name,
            "run_id": self.run_id,
            "level": level,
            "message": message,
            **context
        }
        getattr(self.logger, level.lower())(json.dumps(log_entry))

    def info(self, message: str, **context):
        self._log("INFO", message, **context)

    def error(self, message: str, **context):
        self._log("ERROR", message, **context)

    def metric(self, name: str, value: Any, **tags):
        """Log a metric for monitoring."""
        self._log("METRIC", f"{name}={value}", metric_name=name, metric_value=value, **tags)

class JsonFormatter(logging.Formatter):
    """JSON log formatter."""
    def format(self, record):
        return record.getMessage()

# Usage in notebooks
logger = StructuredLogger("etl-pipeline", dbutils.notebook.entry_point.getDbutils().notebook().getContext().runId())
logger.info("Starting bronze ingestion", source="s3://bucket/raw")
logger.metric("rows_processed", 10000, table="orders")
```

### Step 5: Custom Metrics Dashboard

```python
# src/monitoring/dashboard.py
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import (
    Dashboard,
    Widget,
    Query,
)

def create_monitoring_dashboard(w: WorkspaceClient) -> str:
    """Create operational monitoring dashboard."""

    # Create dashboard
    dashboard = w.dashboards.create(
        name="Data Platform Monitoring",
        tags=["monitoring", "operations"],
    )

    # Job Success Rate Widget
    job_success_query = """
    SELECT
        DATE(start_time) as date,
        job_name,
        ROUND(SUM(CASE WHEN result_state = 'SUCCESS' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as success_rate
    FROM system.lakeflow.job_run_timeline
    WHERE start_time > current_timestamp() - INTERVAL 7 DAYS
    GROUP BY DATE(start_time), job_name
    ORDER BY date, job_name
    """

    # Add widgets...
    # (Dashboard API implementation)

    return dashboard.id

# Generate Grafana dashboard JSON
def generate_grafana_dashboard() -> dict:
    """Generate Grafana dashboard configuration."""
    return {
        "dashboard": {
            "title": "Databricks Monitoring",
            "panels": [
                {
                    "title": "Job Success Rate",
                    "type": "timeseries",
                    "targets": [{
                        "rawSql": """
                            SELECT
                                start_time as time,
                                success_rate
                            FROM monitoring.job_health_summary
                        """
                    }]
                },
                {
                    "title": "Daily DBU Usage",
                    "type": "bargauge",
                    "targets": [{
                        "rawSql": """
                            SELECT date, total_dbus
                            FROM monitoring.daily_costs
                            WHERE date > current_date() - 7
                        """
                    }]
                }
            ]
        }
    }
```

### Step 6: Integration with External Monitoring

```python
# src/monitoring/external.py
import requests
from dataclasses import dataclass

@dataclass
class MetricPoint:
    name: str
    value: float
    tags: dict
    timestamp: int = None

class DatadogExporter:
    """Export metrics to Datadog."""

    def __init__(self, api_key: str, app_key: str):
        self.api_key = api_key
        self.app_key = app_key
        self.base_url = "https://api.datadoghq.com/api/v2"

    def send_metrics(self, metrics: list[MetricPoint]):
        """Send metrics to Datadog."""
        series = []
        for m in metrics:
            series.append({
                "metric": f"databricks.{m.name}",
                "points": [[m.timestamp or int(time.time()), m.value]],
                "tags": [f"{k}:{v}" for k, v in m.tags.items()]
            })

        response = requests.post(
            f"{self.base_url}/series",
            headers={
                "DD-API-KEY": self.api_key,
                "DD-APPLICATION-KEY": self.app_key,
            },
            json={"series": series}
        )
        return response.status_code == 202

# Usage
exporter = DatadogExporter(api_key, app_key)
exporter.send_metrics([
    MetricPoint("job.duration_minutes", 45.2, {"job": "etl-pipeline", "env": "prod"}),
    MetricPoint("job.rows_processed", 1000000, {"job": "etl-pipeline", "env": "prod"}),
])
```

## Output
- System table queries configured
- Monitoring views created
- SQL alerts active
- Structured logging implemented
- External integrations ready

## Error Handling
| Issue | Cause | Solution |
|-------|-------|----------|
| System tables unavailable | Feature not enabled | Contact admin to enable |
| Alert not triggering | Wrong schedule | Check cron expression |
| Missing metrics | Query timeout | Optimize query or increase warehouse |
| High cardinality | Too many tags | Reduce label dimensions |

## Examples

### Quick Health Check Query
```sql
SELECT
    job_name,
    success_rate,
    avg_duration_minutes,
    last_run_time
FROM monitoring.job_health_summary
WHERE success_rate < 95
ORDER BY success_rate ASC;
```

## Resources
- [Databricks System Tables](https://docs.databricks.com/administration-guide/system-tables/index.html)
- [SQL Alerts](https://docs.databricks.com/sql/user/alerts/index.html)
- [Dashboards](https://docs.databricks.com/sql/user/dashboards/index.html)

## Next Steps
For incident response, see `databricks-incident-runbook`.
