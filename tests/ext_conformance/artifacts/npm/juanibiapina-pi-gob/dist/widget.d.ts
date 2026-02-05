/**
 * Widget rendering for gob running jobs.
 * Renders a single horizontal line showing running jobs.
 *
 * Layout: ● server 0:12:34 │ ● build ████░░░ 57% │ ● lint 0:00:05
 */
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { JobResponse } from "./types.js";
/**
 * Render the running jobs widget as a single horizontal line.
 * Returns an empty array if no running jobs.
 *
 * @param jobs - Running jobs to display
 * @param theme - Theme for styling
 * @param width - Terminal width for truncation
 */
export declare function renderJobWidget(jobs: JobResponse[], theme: Theme, width: number): string[];
//# sourceMappingURL=widget.d.ts.map