import { importResearchReportsFromDirectory, runResearchSelection } from "./research-core.mjs";

try {
  const imported = await importResearchReportsFromDirectory();
  console.log(`Research reports imported: ${imported.imported}`);
  const output = await runResearchSelection();
  console.log(`Research selection generated: ${output.summary.candidateCount} candidates from ${output.summary.reportCount} reports.`);
} catch (error) {
  console.error(`Research refresh failed: ${error.message}`);
  process.exitCode = 1;
}
