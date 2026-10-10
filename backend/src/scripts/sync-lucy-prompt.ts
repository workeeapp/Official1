import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { loadLlmConfig } from "../config/llm.js";

const prisma = new PrismaClient();
const config = loadLlmConfig();
const lucyWhere = {
  kind: "digital",
  OR: [{ isProtected: true }, { name: "לוסי" }],
};

// Workers that inherited Lucy keep her runtime engine only while their prompt equals hers.
const lucyRows = await prisma.employee.findMany({
  where: lucyWhere,
  select: { id: true, instructions: true },
});
const previousPrompts = [
  ...new Set(
    lucyRows
      .map((row) => row.instructions?.trim() ?? "")
      .filter((text) => text.length > 0),
  ),
];
const digitalWorkers = await prisma.employee.findMany({
  where: { kind: "digital", id: { notIn: lucyRows.map((row) => row.id) } },
  select: { id: true, instructions: true },
});
const inheritedIds = digitalWorkers
  .filter((row) => previousPrompts.includes(row.instructions?.trim() ?? ""))
  .map((row) => row.id);

const lucyResult = await prisma.employee.updateMany({
  where: lucyWhere,
  data: {
    instructions: config.systemMessage,
    model: config.model,
    temperature: config.temperature,
    reasoningEffort: config.reasoningEffort,
  },
});
const inheritedResult = await prisma.employee.updateMany({
  where: { id: { in: inheritedIds } },
  data: { instructions: config.systemMessage },
});
console.log(
  `updated ${lucyResult.count} lucy rows, ${inheritedResult.count} inherited workers, prompt chars ${config.systemMessage.length}`,
);
await prisma.$disconnect();
