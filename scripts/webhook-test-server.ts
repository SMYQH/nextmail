import { createServer } from "node:http"
import { EmailMessage } from "../app/lib/webhook"

const server = createServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(405); response.end("Method not allowed"); return }
  try {
    const body = await new Promise<string>((resolve, reject) => { let data = ""; request.on("data", chunk => { data += chunk }); request.on("end", () => resolve(data)); request.on("error", reject) })
    const email = JSON.parse(body) as EmailMessage
    console.log("Webhook received:", email.subject)
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ success: true }))
  } catch (error) {
    console.error("Error processing webhook:", error)
    response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "Invalid request" }))
  }
})
server.listen(3001, () => console.log("Webhook test server listening on http://localhost:3001"))
