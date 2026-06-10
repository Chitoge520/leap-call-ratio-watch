import { importResearchReportsFromDirectory } from "./research-core.mjs";

try {
  const result = await importResearchReportsFromDirectory();
  console.log(`Research reports imported: ${result.imported}`);
  for (const report of result.reports) {
    console.log(`${report.status}${report.duplicate ? " duplicate" : ""}: ${report.fileName}`);
  }
} catch (error) {
  console.error(`Research import failed: ${error.message}`);
  process.exitCode = 1;
}
