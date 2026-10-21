import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const lucy = await prisma.employee.findFirst({
    where: {
      kind: "digital",
      OR: [{ isProtected: true }, { name: "לוסי" }],
    },
    select: {
      id: true,
      name: true,
      isProtected: true,
      model: true,
      temperature: true,
      reasoningEffort: true,
      instructions: true,
    },
    orderBy: { isProtected: "desc" },
  });

  if (!lucy?.instructions?.trim()) {
    throw new Error("No Lucy digital employee with non-empty instructions");
  }

  const systemMessage = lucy.instructions.replace(/\r\n/g, "\n").split("\n");
  const config = {
    model: lucy.model?.trim() || "gpt-6-luna",
    temperature: typeof lucy.temperature === "number" ? lucy.temperature : 0,
    reasoningEffort: lucy.reasoningEffort?.trim() || "low",
    systemMessage,
  };

  const outPath = resolve(process.cwd(), "..", "LLM.config.json");
  writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        outPath,
        lucyId: lucy.id,
        name: lucy.name,
        isProtected: lucy.isProtected,
        model: config.model,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
        lines: systemMessage.length,
        chars: lucy.instructions.length,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
