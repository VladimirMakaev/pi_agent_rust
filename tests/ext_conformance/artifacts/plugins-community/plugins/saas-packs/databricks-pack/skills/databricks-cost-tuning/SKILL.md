---
name: databricks-cost-tuning
description: |
  Optimize Databricks costs with cluster policies, spot instances, and monitoring.
  Use when reducing cloud spend, implementing cost controls,
  or analyzing Databricks usage costs.
  Trigger with phrases like "databricks cost", "reduce databricks spend",
  "databricks billing", "databricks cost optimization", "cluster cost".
allowed-tools: Read, Write, Edit, Bash(databricks:*), Grep
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# Databricks Cost Tuning

## Overview
Optimize Databricks costs through cluster policies, instance selection, and monitoring.

## Prerequisites
- Workspace admin access
- Access to billing data
- Understanding of workload patterns

## Instructions

### Step 1: Implement Cluster Policies

```json
// policies/cost_controlled_policy.json
{
  "cluster_type": {
    "type": "fixed",
    "value": "job"
  },
  "autotermination_minutes": {
    "type": "range",
    "minValue": 10,
    "maxValue": 60,
    "defaultValue": 30
  },
  "num_workers": {
    "type": "range",
    "minValue": 1,
    "maxValue": 10,
    "defaultValue": 2
  },
  "node_type_id": {
    "type": "allowlist",
    "values": [
      "Standard_DS3_v2",
      "Standard_DS4_v2",
      "Standard_E4ds_v4"
    ],
    "defaultValue": "Standard_DS3_v2"
  },
  "spark_version": {
    "type": "regex",
    "pattern": "14\\.[0-9]+\\.x-scala2\\.12"
  },
  "azure_attributes.spot_bid_max_price": {
    "type": "fixed",
    "value": -1
  },
  "azure_attributes.first_on_demand": {
    "type": "fixed",
    "value": 1
  },
  "custom_tags.cost_center": {
    "type": "fixed",
    "value": "data-engineering"
  }
}
```

```python
# Create policy via SDK
from databricks.sdk import WorkspaceClient
import json

def create_cost_policy(w: WorkspaceClient, policy_name: str) -> str:
    """Create cost-controlled cluster policy."""

    policy_definition = {
        "autotermination_minutes": {
            "type": "range",
            "minValue": 10,
            "maxValue": 60,
            "defaultValue": 30,
        },
        "num_workers": {
            "type": "range",
            "minValue": 1,
            "maxValue": 10,
        },
        "node_type_id": {
            "type": "allowlist",
            "values": [
                "Standard_DS3_v2",
                "Standard_DS4_v2",
            ],
        },
        "azure_attributes.spot_bid_max_price": {
            "type": "fixed",
            "value": -1,  # Use spot instances
        },
        "azure_attributes.first_on_demand": {
            "type": "fixed",
            "value": 1,  # At least 1 on-demand for driver
        },
    }

    policy = w.cluster_policies.create(
        name=policy_name,
        definition=json.dumps(policy_definition),
    )

    return policy.policy_id
```

### Step 2: Spot Instance Configuration

```yaml
# resources/cost_optimized_cluster.yml
job_clusters:
  - job_cluster_key: cost_optimized
    new_cluster:
      spark_version: "14.3.x-scala2.12"
      node_type_id: "Standard_DS3_v2"
      num_workers: 4

      # Azure Spot Configuration
      azure_attributes:
        first_on_demand: 1         # Driver on-demand
        availability: SPOT_AZURE   # Workers on spot
        spot_bid_max_price: -1     # Pay up to on-demand price

      # AWS Spot Configuration (alternative)
      # aws_attributes:
      #   first_on_demand: 1
      #   availability: SPOT_WITH_FALLBACK
      #   spot_bid_price_percent: 100

      autoscale:
        min_workers: 1
        max_workers: 8

      custom_tags:
        cost_center: analytics
        environment: production
```

### Step 3: Instance Pool for Faster Startup

```python
# Create instance pool for reduced startup time and costs
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.compute import (
    InstancePoolAndStats,
    InstancePoolAzureAttributes,
)

def create_cost_optimized_pool(
    w: WorkspaceClient,
    pool_name: str,
    min_idle: int = 1,
    max_capacity: int = 10,
    idle_timeout: int = 15,
) -> str:
    """
    Create instance pool for cost optimization.

    Benefits:
    - Faster cluster startup (instances pre-warmed)
    - Lower spot instance preemption risk
    - Consistent performance
    """
    pool = w.instance_pools.create(
        instance_pool_name=pool_name,
        node_type_id="Standard_DS3_v2",
        min_idle_instances=min_idle,
        max_capacity=max_capacity,
        idle_instance_autotermination_minutes=idle_timeout,
        azure_attributes=InstancePoolAzureAttributes(
            availability="SPOT_AZURE",
            spot_bid_max_price=-1,
        ),
        preloaded_spark_versions=["14.3.x-scala2.12"],
        custom_tags={
            "pool_type": "cost_optimized",
            "managed_by": "terraform",
        },
    )

    return pool.instance_pool_id
```

### Step 4: Cost Monitoring

```sql
-- Analyze cluster costs from system tables
SELECT
    cluster_name,
    cluster_id,
    DATE(usage_date) as date,
    SUM(usage_quantity) as dbu_usage,
    SUM(usage_quantity * list_price) as estimated_cost
FROM system.billing.usage
WHERE usage_date > current_date() - INTERVAL 30 DAYS
  AND usage_type = 'COMPUTE'
GROUP BY cluster_name, cluster_id, DATE(usage_date)
ORDER BY estimated_cost DESC;

-- Top cost drivers by job
SELECT
    job_name,
    COUNT(DISTINCT run_id) as runs,
    SUM(duration) / 3600000 as total_hours,
    AVG(duration) / 60000 as avg_minutes,
    SUM(dbu_usage) as total_dbus
FROM system.lakeflow.job_run_timeline r
JOIN system.billing.usage u ON r.cluster_id = u.cluster_id
WHERE r.start_time > current_timestamp() - INTERVAL 30 DAYS
GROUP BY job_name
ORDER BY total_dbus DESC
LIMIT 20;

-- Identify idle clusters
SELECT
    cluster_name,
    cluster_id,
    state,
    last_activity_time,
    TIMESTAMPDIFF(HOUR, last_activity_time, current_timestamp()) as idle_hours
FROM system.compute.clusters
WHERE state = 'RUNNING'
  AND TIMESTAMPDIFF(MINUTE, last_activity_time, current_timestamp()) > 30
ORDER BY idle_hours DESC;
```

### Step 5: Cost Allocation Tags

```python
# Implement cost allocation with tags
from databricks.sdk import WorkspaceClient

def enforce_cost_tags(
    w: WorkspaceClient,
    required_tags: list[str] = ["cost_center", "team", "environment"],
) -> list[dict]:
    """
    Audit and report clusters missing required cost tags.

    Returns list of non-compliant clusters.
    """
    non_compliant = []

    for cluster in w.clusters.list():
        tags = cluster.custom_tags or {}
        missing_tags = [t for t in required_tags if t not in tags]

        if missing_tags:
            non_compliant.append({
                "cluster_id": cluster.cluster_id,
                "cluster_name": cluster.cluster_name,
                "missing_tags": missing_tags,
                "creator": cluster.creator_user_name,
            })

    return non_compliant

# Cost allocation report
def generate_cost_report(w: WorkspaceClient, spark) -> dict:
    """Generate cost allocation report by tags."""
    query = """
        SELECT
            custom_tags:cost_center as cost_center,
            custom_tags:team as team,
            SUM(usage_quantity * list_price) as total_cost
        FROM system.billing.usage
        WHERE usage_date > current_date() - INTERVAL 30 DAYS
        GROUP BY custom_tags:cost_center, custom_tags:team
        ORDER BY total_cost DESC
    """
    return spark.sql(query).toPandas().to_dict('records')
```

### Step 6: Auto-Termination and Scheduling

```python
# Job scheduling for cost optimization
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.jobs import CronSchedule

def configure_off_hours_schedule(
    w: WorkspaceClient,
    job_id: int,
    cron_expression: str = "0 0 2 * * ?",  # 2 AM daily
    timezone: str = "America/New_York",
) -> None:
    """Configure job to run during off-peak hours."""
    w.jobs.update(
        job_id=job_id,
        new_settings={
            "schedule": {
                "quartz_cron_expression": cron_expression,
                "timezone_id": timezone,
            }
        }
    )

# Cluster auto-stop policy
def set_aggressive_auto_termination(
    w: WorkspaceClient,
    cluster_id: str,
    minutes: int = 15,
) -> None:
    """Set aggressive auto-termination for development clusters."""
    cluster = w.clusters.get(cluster_id)
    w.clusters.edit(
        cluster_id=cluster_id,
        spark_version=cluster.spark_version,
        node_type_id=cluster.node_type_id,
        autotermination_minutes=minutes,
    )
```

## Output
- Cost-controlled cluster policies
- Spot instance optimization
- Instance pools configured
- Cost monitoring dashboards
- Auto-termination policies

## Error Handling
| Issue | Cause | Solution |
|-------|-------|----------|
| Spot preemption | Instance reclaimed | Use first_on_demand for stability |
| Policy violation | Cluster over limits | Adjust policy or request exception |
| Missing tags | Manual cluster creation | Enforce policy with required tags |
| High idle costs | Long auto-term timeout | Reduce to 15-30 minutes |

## Examples

### Cost Savings Calculator
```python
def estimate_spot_savings(
    on_demand_cost: float,
    spot_ratio: float = 0.7,  # 70% workers on spot
    spot_discount: float = 0.6,  # 60% discount
) -> dict:
    """Estimate savings from spot instances."""
    on_demand_portion = on_demand_cost * (1 - spot_ratio)
    spot_portion = on_demand_cost * spot_ratio * (1 - spot_discount)
    new_cost = on_demand_portion + spot_portion
    savings = on_demand_cost - new_cost

    return {
        "original_cost": on_demand_cost,
        "optimized_cost": new_cost,
        "savings": savings,
        "savings_percent": (savings / on_demand_cost) * 100,
    }
```

### Weekly Cost Alert
```sql
-- Alert when costs exceed threshold
CREATE ALERT weekly_cost_alert
AS SELECT
    SUM(usage_quantity * list_price) as weekly_cost
FROM system.billing.usage
WHERE usage_date > current_date() - INTERVAL 7 DAYS
HAVING weekly_cost > 10000  -- $10k threshold
SCHEDULE CRON '0 9 * * 1'  -- Monday 9 AM
NOTIFICATIONS (email_addresses = ['finops@company.com']);
```

## Resources
- [Databricks Pricing](https://databricks.com/product/pricing)
- [Cluster Policies](https://docs.databricks.com/administration-guide/clusters/policies.html)
- [Instance Pools](https://docs.databricks.com/clusters/instance-pools/index.html)
- [Cost Management](https://docs.databricks.com/administration-guide/account-settings/billable-usage.html)

## Next Steps
For reference architecture, see `databricks-reference-architecture`.
