#!/usr/bin/env node

/**
 * Delentia OS MCP Interactive Live Console
 * Designed for Antigravity & The Architect
 * Allows testing and interacting with all 4 live MCP servers directly in your terminal.
 */

import readline from "node:readline";

const SERVERS = {
  fdia: "https://delentia-fdia-mcp.delentia.workers.dev/mcp",
  rct7: "https://delentia-rct7-mcp.delentia.workers.dev/mcp",
  delta: "https://delentia-delta-mcp.delentia.workers.dev/mcp",
  jitna: "https://delentia-jitna-mcp.delentia.workers.dev/mcp",
};

async function callLiveMCP(serverKey, toolName, params) {
  const url = SERVERS[serverKey];
  const start = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: toolName, ...params }),
  });
  const duration = (performance.now() - start).toFixed(2);
  const data = await res.json();
  return { duration, data };
}

console.log("\n=======================================================");
console.log("   DELENTIA OS MCP - SOVEREIGN CONSOLE (LIVE ON EDGE)");
console.log("=======================================================");
console.log("1. FDIA Security Gate   : F = (D^I) * A Evaluation");
console.log("2. RCT-7 Mental OS      : 7-Stage Reverse Thinking");
console.log("3. Delta Engine         : Context Token Compression");
console.log("4. JITNA Swarm          : 1+N Multi-Agent Packet Dispatch");
console.log("=======================================================\n");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function promptUser() {
  console.log("\n[เลือกหมายเลข 1-4 หรือพิมพ์ 'exit' เพื่อออก]:");
  rl.question("> ", async (choice) => {
    const trimmed = choice.trim();
    if (trimmed === "exit" || trimmed === "q") {
      console.log("Exiting Delentia Console. Farewell, Architect!");
      rl.close();
      return;
    }

    try {
      if (trimmed === "1") {
        console.log("\n[FDIA Security Gate] ป้อนชื่อคำสั่ง (Action Name) เช่น 'drop_database' หรือ 'read_logs':");
        rl.question("Action: ", async (actionName) => {
          console.log("Evaluating against live Cloudflare Edge...");
          const { duration, data } = await callLiveMCP("fdia", "evaluate_fdia", {
            action_name: actionName || "test_action",
            data_quality: 0.95,
            intent_precision: 1.0,
            authorized: true,
          });
          console.log(`\n⚡ ตอบกลับใน ${duration} ms:`);
          console.log(data.result.content[0].text);
          promptUser();
        });
      } else if (trimmed === "2") {
        console.log("\n[RCT-7 Reverse Thinking] ป้อนปัญหาที่ต้องการให้คิดย้อนกลับ 7 ขั้นตอน:");
        rl.question("Problem: ", async (problem) => {
          console.log("Executing 7-stage cognitive pipeline...");
          const { duration, data } = await callLiveMCP("rct7", "rct_think", {
            problem_statement: problem || "Prevent distributed race conditions",
          });
          console.log(`\n⚡ ตอบกลับใน ${duration} ms:`);
          console.log(data.result.content[0].text);
          promptUser();
        });
      } else if (trimmed === "3") {
        console.log("\n[Delta Engine] ป้อนข้อความยาวที่ต้องการบีบอัด Context:");
        rl.question("Text: ", async (text) => {
          const sample = text || "Info: connection ok\nDebug: ping\nCritical Error: payment dropped\nInfo: keepalive";
          const { duration, data } = await callLiveMCP("delta", "compress_context", {
            raw_context: sample,
            intent_focus: "error",
          });
          console.log(`\n⚡ ตอบกลับใน ${duration} ms:`);
          console.log(data.result.content[0].text);
          promptUser();
        });
      } else if (trimmed === "4") {
        console.log("\n[JITNA Swarm] ป้อนเป้าหมายของ Swarm (Objective):");
        rl.question("Objective: ", async (obj) => {
          const { duration, data } = await callLiveMCP("jitna", "orchestrate_swarm", {
            objective: obj || "Security penetration audit",
          });
          console.log(`\n⚡ ตอบกลับใน ${duration} ms:`);
          console.log(data.result.content[0].text);
          promptUser();
        });
      } else {
        console.log("ตัวเลือกไม่ถูกต้อง กรุณาเลือก 1, 2, 3 หรือ 4");
        promptUser();
      }
    } catch (err) {
      console.error("Error executing live call:", err.message);
      promptUser();
    }
  });
}

promptUser();
