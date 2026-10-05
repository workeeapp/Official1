import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { loadLlmConfig } from "../config/llm.js";

const prisma = new PrismaClient();
const config = loadLlmConfig();
const result = await prisma.employee.updateMany({
  where: { name: "לוסי", kind: "digital" },
  data: {
    instructions: config.systemMessage,
    model: config.model,
    temperature: config.temperature,
  },
});
console.log(
  `updated ${result.count} lucy rows, prompt chars ${config.systemMessage.length}`,
);
await prisma.$disconnect();
