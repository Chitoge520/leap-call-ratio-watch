import { runResearchSelection } from "./research-core.mjs";

try {
  const output = await runResearchSelection();
  console.log(`Research selection generated: ${output.summary.candidateCount} candidates from ${output.summary.reportCount} reports.`);
  console.log(`AI status: ${output.aiStatus?.status || "unknown"}`);
} catch (error) {
  console.error(`Research analysis failed: ${error.message}`);
  process.exitCode = 1;
}
