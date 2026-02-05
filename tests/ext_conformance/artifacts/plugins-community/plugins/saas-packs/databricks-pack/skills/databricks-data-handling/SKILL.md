---
name: databricks-data-handling
description: |
  Implement Delta Lake data management patterns including GDPR, PII handling, and data lifecycle.
  Use when implementing data retention, handling GDPR requests,
  or managing data lifecycle in Delta Lake.
  Trigger with phrases like "databricks GDPR", "databricks PII",
  "databricks data retention", "databricks data lifecycle", "delete user data".
allowed-tools: Read, Write, Edit, Bash(databricks:*)
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# Databricks Data Handling

## Overview
Implement data management patterns for compliance, privacy, and lifecycle in Delta Lake.

## Prerequisites
- Unity Catalog configured
- Understanding of Delta Lake features
- Compliance requirements documented
- Data classification in place

## Instructions

### Step 1: Data Classification and Tagging

```sql
-- Tag tables with data classification
ALTER TABLE catalog.schema.customers
SET TAGS ('data_classification' = 'PII', 'retention_days' = '365');

ALTER TABLE catalog.schema.orders
SET TAGS ('data_classification' = 'CONFIDENTIAL', 'retention_days' = '2555');

ALTER TABLE catalog.schema.analytics_events
SET TAGS ('data_classification' = 'INTERNAL', 'retention_days' = '90');

-- Tag columns with sensitivity
ALTER TABLE catalog.schema.customers
ALTER COLUMN email SET TAGS ('pii' = 'true', 'pii_type' = 'email');

ALTER TABLE catalog.schema.customers
ALTER COLUMN phone SET TAGS ('pii' = 'true', 'pii_type' = 'phone');

-- Query classified data
SELECT
    table_catalog,
    table_schema,
    table_name,
    tag_name,
    tag_value
FROM system.information_schema.table_tags
WHERE tag_name = 'data_classification';
```

### Step 2: GDPR Right to Deletion (RTBF)

```python
# src/compliance/gdpr.py
from pyspark.sql import SparkSession
from delta.tables import DeltaTable
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

class GDPRHandler:
    """Handle GDPR data subject requests."""

    def __init__(self, spark: SparkSession, catalog: str):
        self.spark = spark
        self.catalog = catalog

    def process_deletion_request(
        self,
        user_id: str,
        request_id: str,
        dry_run: bool = True,
    ) -> dict:
        """
        Process GDPR deletion request for a user.

        Args:
            user_id: User identifier to delete
            request_id: GDPR request tracking ID
            dry_run: If True, only report what would be deleted

        Returns:
            Deletion report
        """
        report = {
            "request_id": request_id,
            "user_id": user_id,
            "timestamp": datetime.utcnow().isoformat(),
            "dry_run": dry_run,
            "tables_processed": [],
            "total_rows_deleted": 0,
        }

        # Find all tables with PII tag
        pii_tables = self._get_pii_tables()

        for table_info in pii_tables:
            table_name = f"{table_info['catalog']}.{table_info['schema']}.{table_info['table']}"
            user_column = self._get_user_column(table_name)

            if not user_column:
                continue

            # Count rows to be deleted
            count_query = f"SELECT COUNT(*) FROM {table_name} WHERE {user_column} = '{user_id}'"
            row_count = self.spark.sql(count_query).first()[0]

            if row_count > 0:
                table_report = {
                    "table": table_name,
                    "rows_to_delete": row_count,
                    "deleted": False,
                }

                if not dry_run:
                    # Delete using Delta Lake DELETE
                    self.spark.sql(f"""
                        DELETE FROM {table_name}
                        WHERE {user_column} = '{user_id}'
                    """)
                    table_report["deleted"] = True

                    # Log deletion for audit
                    self._log_deletion(request_id, table_name, user_id, row_count)

                report["tables_processed"].append(table_report)
                report["total_rows_deleted"] += row_count

        return report

    def _get_pii_tables(self) -> list[dict]:
        """Get all tables tagged as containing PII."""
        query = f"""
            SELECT DISTINCT
                table_catalog as catalog,
                table_schema as schema,
                table_name as table
            FROM {self.catalog}.information_schema.table_tags
            WHERE tag_name = 'data_classification'
              AND tag_value = 'PII'
        """
        return [row.asDict() for row in self.spark.sql(query).collect()]

    def _get_user_column(self, table_name: str) -> str:
        """Determine user identifier column for table."""
        # Check for common user ID columns
        columns = [c.name for c in self.spark.table(table_name).schema]
        user_columns = ['user_id', 'customer_id', 'account_id', 'member_id']

        for uc in user_columns:
            if uc in columns:
                return uc
        return None

    def _log_deletion(
        self,
        request_id: str,
        table_name: str,
        user_id: str,
        row_count: int
    ):
        """Log deletion for compliance audit."""
        self.spark.sql(f"""
            INSERT INTO {self.catalog}.compliance.deletion_log
            VALUES (
                '{request_id}',
                '{table_name}',
                '{user_id}',
                {row_count},
                current_timestamp()
            )
        """)

# Usage
gdpr = GDPRHandler(spark, "prod_catalog")
report = gdpr.process_deletion_request(
    user_id="user-12345",
    request_id="GDPR-2024-001",
    dry_run=True  # Set to False to actually delete
)
print(report)
```

### Step 3: Data Retention Policies

```python
# src/compliance/retention.py
from pyspark.sql import SparkSession
from datetime import datetime, timedelta

class DataRetentionManager:
    """Manage data retention and cleanup."""

    def __init__(self, spark: SparkSession, catalog: str):
        self.spark = spark
        self.catalog = catalog

    def apply_retention_policies(self, dry_run: bool = True) -> list[dict]:
        """
        Apply retention policies based on table tags.

        Returns:
            List of tables processed with row counts
        """
        results = []

        # Get tables with retention tags
        tables = self.spark.sql(f"""
            SELECT
                table_catalog,
                table_schema,
                table_name,
                CAST(tag_value AS INT) as retention_days
            FROM {self.catalog}.information_schema.table_tags
            WHERE tag_name = 'retention_days'
        """).collect()

        for table in tables:
            full_name = f"{table.table_catalog}.{table.table_schema}.{table.table_name}"
            cutoff_date = datetime.now() - timedelta(days=table.retention_days)

            # Find date column
            date_col = self._get_date_column(full_name)
            if not date_col:
                continue

            # Count rows to delete
            count = self.spark.sql(f"""
                SELECT COUNT(*) FROM {full_name}
                WHERE {date_col} < '{cutoff_date.strftime('%Y-%m-%d')}'
            """).first()[0]

            result = {
                "table": full_name,
                "retention_days": table.retention_days,
                "cutoff_date": cutoff_date.strftime('%Y-%m-%d'),
                "rows_to_delete": count,
                "deleted": False,
            }

            if not dry_run and count > 0:
                self.spark.sql(f"""
                    DELETE FROM {full_name}
                    WHERE {date_col} < '{cutoff_date.strftime('%Y-%m-%d')}'
                """)
                result["deleted"] = True

            results.append(result)

        return results

    def vacuum_tables(self, retention_hours: int = 168) -> list[dict]:
        """
        Vacuum Delta tables to remove old files.

        Args:
            retention_hours: Hours of history to retain (default 7 days)
        """
        results = []

        # Get all Delta tables
        tables = self.spark.sql(f"""
            SELECT table_catalog, table_schema, table_name
            FROM {self.catalog}.information_schema.tables
            WHERE table_type = 'MANAGED'
        """).collect()

        for table in tables:
            full_name = f"{table.table_catalog}.{table.table_schema}.{table.table_name}"

            try:
                self.spark.sql(f"VACUUM {full_name} RETAIN {retention_hours} HOURS")
                results.append({"table": full_name, "status": "vacuumed"})
            except Exception as e:
                results.append({"table": full_name, "status": "error", "error": str(e)})

        return results

    def _get_date_column(self, table_name: str) -> str:
        """Find appropriate date column for retention."""
        columns = [c.name for c in self.spark.table(table_name).schema]
        date_columns = ['created_at', 'event_date', 'timestamp', 'date', 'updated_at']

        for dc in date_columns:
            if dc in columns:
                return dc
        return None

# Scheduled job for retention
def run_daily_retention(spark):
    """Run as scheduled job."""
    manager = DataRetentionManager(spark, "prod_catalog")

    # Apply retention policies
    retention_results = manager.apply_retention_policies(dry_run=False)
    print(f"Retention applied: {len(retention_results)} tables processed")

    # Vacuum tables
    vacuum_results = manager.vacuum_tables()
    print(f"Vacuum completed: {len(vacuum_results)} tables")
```

### Step 4: PII Masking and Anonymization

```python
# src/compliance/masking.py
from pyspark.sql import DataFrame
from pyspark.sql.functions import (
    col, sha2, concat, lit, regexp_replace,
    when, substring, length
)

class PIIMasker:
    """Mask PII data for analytics and testing."""

    @staticmethod
    def mask_email(df: DataFrame, column: str) -> DataFrame:
        """Mask email addresses: john.doe@company.com -> j***@***.com"""
        return df.withColumn(
            column,
            concat(
                substring(col(column), 1, 1),
                lit("***@***."),
                regexp_replace(col(column), r".*\.(\w+)$", "$1")
            )
        )

    @staticmethod
    def mask_phone(df: DataFrame, column: str) -> DataFrame:
        """Mask phone numbers: +1-555-123-4567 -> +1-555-***-****"""
        return df.withColumn(
            column,
            regexp_replace(col(column), r"(\d{3})-(\d{4})$", "***-****")
        )

    @staticmethod
    def hash_identifier(df: DataFrame, column: str, salt: str = "") -> DataFrame:
        """Hash identifiers for pseudonymization."""
        return df.withColumn(
            column,
            sha2(concat(col(column), lit(salt)), 256)
        )

    @staticmethod
    def mask_name(df: DataFrame, column: str) -> DataFrame:
        """Mask names: John Smith -> J*** S***"""
        return df.withColumn(
            column,
            regexp_replace(col(column), r"(\w)\w+", "$1***")
        )

    @staticmethod
    def create_masked_view(
        spark,
        source_table: str,
        view_name: str,
        masking_rules: dict[str, str],
    ) -> None:
        """
        Create a view with masked PII columns.

        Args:
            spark: SparkSession
            source_table: Source table name
            view_name: Name for masked view
            masking_rules: Dict of {column: masking_type}
                          Types: email, phone, hash, name, redact
        """
        df = spark.table(source_table)

        for column, mask_type in masking_rules.items():
            if mask_type == "email":
                df = PIIMasker.mask_email(df, column)
            elif mask_type == "phone":
                df = PIIMasker.mask_phone(df, column)
            elif mask_type == "hash":
                df = PIIMasker.hash_identifier(df, column)
            elif mask_type == "name":
                df = PIIMasker.mask_name(df, column)
            elif mask_type == "redact":
                df = df.withColumn(column, lit("[REDACTED]"))

        df.createOrReplaceTempView(view_name)

# Usage
PIIMasker.create_masked_view(
    spark,
    "prod_catalog.customers.users",
    "masked_users",
    {
        "email": "email",
        "phone": "phone",
        "full_name": "name",
        "ssn": "redact",
    }
)
```

### Step 5: Row-Level Security

```sql
-- Create row filter function
CREATE OR REPLACE FUNCTION catalog.security.region_filter(region STRING)
RETURNS BOOLEAN
RETURN (
    -- Allow access if user is admin
    IS_ACCOUNT_GROUP_MEMBER('data-admins')
    OR
    -- Or if region matches user's assigned region
    region = current_user_attribute('region')
);

-- Apply row filter to table
ALTER TABLE catalog.schema.sales
SET ROW FILTER catalog.security.region_filter ON (region);

-- Column masking function
CREATE OR REPLACE FUNCTION catalog.security.mask_salary(salary DECIMAL)
RETURNS DECIMAL
RETURN CASE
    WHEN IS_ACCOUNT_GROUP_MEMBER('hr-team') THEN salary
    ELSE NULL
END;

-- Apply column mask
ALTER TABLE catalog.schema.employees
ALTER COLUMN salary SET MASK catalog.security.mask_salary;
```

## Output
- Data classification tags applied
- GDPR deletion process implemented
- Retention policies enforced
- PII masking configured
- Row-level security enabled

## Error Handling
| Issue | Cause | Solution |
|-------|-------|----------|
| Vacuum fails | Retention too short | Ensure > 7 days retention |
| Delete timeout | Large table | Partition deletes over time |
| Missing user column | Non-standard schema | Map user columns manually |
| Mask function error | Invalid regex | Test masking functions |

## Examples

### GDPR Subject Access Request
```python
def generate_sar_report(spark, user_id: str) -> dict:
    """Generate Subject Access Request report."""
    pii_tables = get_pii_tables(spark)
    report = {"user_id": user_id, "data": {}}

    for table in pii_tables:
        user_col = get_user_column(table)
        if user_col:
            data = spark.sql(f"""
                SELECT * FROM {table}
                WHERE {user_col} = '{user_id}'
            """).toPandas().to_dict('records')
            report["data"][table] = data

    return report
```

## Resources
- [Delta Lake Privacy](https://docs.databricks.com/delta/privacy.html)
- [Unity Catalog Security](https://docs.databricks.com/data-governance/unity-catalog/row-level-security.html)
- [GDPR Compliance](https://docs.databricks.com/security/privacy/gdpr.html)

## Next Steps
For enterprise RBAC, see `databricks-enterprise-rbac`.
