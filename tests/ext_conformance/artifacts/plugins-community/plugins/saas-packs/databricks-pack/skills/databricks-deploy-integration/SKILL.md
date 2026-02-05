---
name: databricks-deploy-integration
description: |
  Deploy Databricks jobs and pipelines with Asset Bundles.
  Use when deploying jobs to different environments, managing deployments,
  or setting up deployment automation.
  Trigger with phrases like "databricks deploy", "asset bundles",
  "databricks deployment", "deploy to production", "bundle deploy".
allowed-tools: Read, Write, Edit, Bash(databricks:*)
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# Databricks Deploy Integration

## Overview
Deploy Databricks workloads using Asset Bundles for environment management.

## Prerequisites
- Databricks CLI v0.200+
- Asset Bundle project structure
- Workspace access for target environments

## Instructions

### Step 1: Project Structure

```
my-databricks-project/
├── databricks.yml              # Main bundle configuration
├── resources/
│   ├── jobs.yml                # Job definitions
│   ├── pipelines.yml           # DLT pipeline definitions
│   └── clusters.yml            # Cluster policies
├── src/
│   ├── notebooks/              # Databricks notebooks
│   │   ├── bronze/
│   │   ├── silver/
│   │   └── gold/
│   └── python/                 # Python modules
│       └── etl/
├── tests/
│   ├── unit/
│   └── integration/
├── fixtures/                   # Test data
└── conf/
    ├── dev.yml                 # Dev overrides
    ├── staging.yml             # Staging overrides
    └── prod.yml                # Production overrides
```

### Step 2: Main Bundle Configuration

```yaml
# databricks.yml
bundle:
  name: data-platform

variables:
  catalog:
    description: Unity Catalog name
    default: dev_catalog
  warehouse_id:
    description: SQL Warehouse ID
    default: ""

include:
  - resources/*.yml

workspace:
  host: ${DATABRICKS_HOST}

artifacts:
  etl_wheel:
    type: whl
    path: ./src/python
    build: poetry build

targets:
  dev:
    default: true
    mode: development
    variables:
      catalog: dev_catalog
    workspace:
      root_path: /Users/${workspace.current_user.userName}/.bundle/${bundle.name}/dev

  staging:
    mode: development
    variables:
      catalog: staging_catalog
    workspace:
      root_path: /Shared/.bundle/${bundle.name}/staging
    run_as:
      service_principal_name: staging-sp

  prod:
    mode: production
    variables:
      catalog: prod_catalog
      warehouse_id: "abc123def456"
    workspace:
      root_path: /Shared/.bundle/${bundle.name}/prod
    run_as:
      service_principal_name: prod-sp
    permissions:
      - level: CAN_VIEW
        group_name: data-consumers
      - level: CAN_MANAGE_RUN
        group_name: data-engineers
      - level: CAN_MANAGE
        service_principal_name: prod-sp
```

### Step 3: Job Definitions

```yaml
# resources/jobs.yml
resources:
  jobs:
    etl_pipeline:
      name: "${bundle.name}-etl-${bundle.target}"
      description: "Main ETL pipeline for ${var.catalog}"

      tags:
        environment: ${bundle.target}
        team: data-engineering
        managed_by: asset_bundles

      schedule:
        quartz_cron_expression: "0 0 6 * * ?"
        timezone_id: "America/New_York"
        pause_status: ${bundle.target == "dev" ? "PAUSED" : "UNPAUSED"}

      email_notifications:
        on_failure:
          - oncall@company.com
        no_alert_for_skipped_runs: true

      parameters:
        - name: catalog
          default: ${var.catalog}
        - name: run_date
          default: ""

      tasks:
        - task_key: bronze_ingest
          job_cluster_key: etl_cluster
          notebook_task:
            notebook_path: ../src/notebooks/bronze/ingest.py
            base_parameters:
              catalog: "{{job.parameters.catalog}}"
              run_date: "{{job.parameters.run_date}}"

        - task_key: silver_transform
          depends_on:
            - task_key: bronze_ingest
          job_cluster_key: etl_cluster
          notebook_task:
            notebook_path: ../src/notebooks/silver/transform.py

        - task_key: gold_aggregate
          depends_on:
            - task_key: silver_transform
          job_cluster_key: etl_cluster
          python_wheel_task:
            package_name: etl
            entry_point: gold_aggregate
          libraries:
            - whl: ../artifacts/etl_wheel/*.whl

        - task_key: data_quality
          depends_on:
            - task_key: gold_aggregate
          job_cluster_key: etl_cluster
          notebook_task:
            notebook_path: ../src/notebooks/quality/validate.py

      job_clusters:
        - job_cluster_key: etl_cluster
          new_cluster:
            spark_version: "14.3.x-scala2.12"
            node_type_id: ${bundle.target == "prod" ? "Standard_DS4_v2" : "Standard_DS3_v2"}
            num_workers: ${bundle.target == "prod" ? 4 : 1}
            autoscale:
              min_workers: ${bundle.target == "prod" ? 2 : 1}
              max_workers: ${bundle.target == "prod" ? 10 : 2}
            spark_conf:
              spark.databricks.delta.optimizeWrite.enabled: "true"
              spark.databricks.delta.autoCompact.enabled: "true"
            custom_tags:
              ResourceClass: ${bundle.target == "prod" ? "production" : "development"}
```

### Step 4: Deployment Commands

```bash
# Validate bundle
databricks bundle validate
databricks bundle validate -t staging
databricks bundle validate -t prod

# Deploy to development
databricks bundle deploy -t dev

# Deploy to staging
databricks bundle deploy -t staging

# Deploy to production (with confirmation)
databricks bundle deploy -t prod

# Deploy specific resources
databricks bundle deploy -t staging --resource etl_pipeline

# Destroy resources (cleanup)
databricks bundle destroy -t dev --auto-approve
```

### Step 5: Run Management

```bash
# Run job manually
databricks bundle run -t staging etl_pipeline

# Run with parameters
databricks bundle run -t staging etl_pipeline \
  --params '{"catalog": "test_catalog", "run_date": "2024-01-15"}'

# Check deployment status
databricks bundle summary -t prod

# View deployed resources
databricks bundle summary -t prod --output json | jq '.resources.jobs'
```

### Step 6: Blue-Green Deployment

```python
# scripts/blue_green_deploy.py
from databricks.sdk import WorkspaceClient
import time

def blue_green_deploy(
    w: WorkspaceClient,
    job_name: str,
    new_config: dict,
    rollback_on_failure: bool = True,
) -> dict:
    """
    Deploy job using blue-green strategy.

    1. Create new job version
    2. Run validation
    3. Switch traffic
    4. Remove old version (or rollback)
    """
    # Find existing job
    jobs = [j for j in w.jobs.list() if j.settings.name == job_name]
    old_job = jobs[0] if jobs else None

    # Create new job with suffix
    new_name = f"{job_name}-new"
    new_config["name"] = new_name
    new_job = w.jobs.create(**new_config)

    try:
        # Run validation job
        run = w.jobs.run_now(job_id=new_job.job_id)
        result = w.jobs.get_run(run.run_id).wait()

        if result.state.result_state != "SUCCESS":
            raise Exception(f"Validation failed: {result.state.state_message}")

        # Success - rename jobs
        if old_job:
            w.jobs.update(
                job_id=old_job.job_id,
                new_settings={"name": f"{job_name}-old"}
            )

        w.jobs.update(
            job_id=new_job.job_id,
            new_settings={"name": job_name}
        )

        # Cleanup old job
        if old_job:
            w.jobs.delete(job_id=old_job.job_id)

        return {"status": "SUCCESS", "job_id": new_job.job_id}

    except Exception as e:
        if rollback_on_failure:
            # Cleanup new job
            w.jobs.delete(job_id=new_job.job_id)
        raise
```

## Output
- Deployed Asset Bundle
- Jobs created in target workspace
- Environment-specific configurations applied

## Error Handling
| Issue | Cause | Solution |
|-------|-------|----------|
| Permission denied | Missing run_as permissions | Configure service principal |
| Resource conflict | Name collision | Use unique names with target suffix |
| Artifact not found | Build failed | Run `databricks bundle build` first |
| Validation error | Invalid YAML | Check bundle syntax |

## Examples

### Environment Comparison
```bash
# Compare configurations across environments
databricks bundle summary -t dev --output json > dev.json
databricks bundle summary -t prod --output json > prod.json
diff <(jq -S . dev.json) <(jq -S . prod.json)
```

### Rollback Procedure
```bash
# Quick rollback using git
git checkout HEAD~1 -- databricks.yml resources/
databricks bundle deploy -t prod --force
```

## Resources
- [Asset Bundles Documentation](https://docs.databricks.com/dev-tools/bundles/index.html)
- [Bundle YAML Reference](https://docs.databricks.com/dev-tools/bundles/settings.html)
- [Deployment Best Practices](https://docs.databricks.com/dev-tools/bundles/best-practices.html)

## Next Steps
For webhooks and events, see `databricks-webhooks-events`.
