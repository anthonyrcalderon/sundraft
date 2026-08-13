// Real backend for the projects API — same contract as mock-server/server.js,
// so the frontend's api/client.ts doesn't need to change when this replaces it.
// One Lambda, routed internally by HTTP method + path (see infra routes).

const {
  DynamoDBClient,
} = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  };
}

function getSessionId(event) {
  return event.headers?.["x-session-id"] || event.headers?.["X-Session-Id"];
}

function isAdmin(event) {
  return event.headers?.["x-admin"] === "true";
}

exports.handler = async (event) => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // GET/POST /projects
    if (path === "/projects" && method === "GET") {
      const sessionId = getSessionId(event);
      if (!sessionId) return json(400, { error: "Missing X-Session-Id header" });

      // Templates (sessionId = "TEMPLATE") + this session's own projects.
      // Two queries against the bySession GSI beats a table scan.
      const [templates, mine] = await Promise.all([
        client.send(
          new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: "isTemplate = :t",
            ExpressionAttributeValues: { ":t": true },
          })
        ),
        client.send(
          new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: "sessionId = :s",
            ExpressionAttributeValues: { ":s": sessionId },
          })
        ),
      ]);
      return json(200, [...(templates.Items || []), ...(mine.Items || [])]);
    }

    if (path === "/projects" && method === "POST") {
      const sessionId = getSessionId(event);
      if (!sessionId) return json(400, { error: "Missing X-Session-Id header" });

      const now = new Date().toISOString();
      const project = {
        id: randomUUID(),
        sessionId,
        isTemplate: false,
        name: body.name || "Untitled design",
        address: body.address || null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        roofOutline: null,
        modules: [],
        createdAt: now,
        updatedAt: now,
      };
      await client.send(new PutCommand({ TableName: TABLE_NAME, Item: project }));
      return json(201, project);
    }

    // GET/PUT/DELETE /projects/{id}
    const idMatch = path.match(/^\/projects\/([^/]+)$/);
    if (idMatch && method === "GET") {
      const res = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { id: idMatch[1] } })
      );
      if (!res.Item) return json(404, { error: "Not found" });
      return json(200, res.Item);
    }

    if (idMatch && method === "PUT") {
      const sessionId = getSessionId(event);
      if (!sessionId) return json(400, { error: "Missing X-Session-Id header" });

      const existing = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { id: idMatch[1] } })
      );
      if (!existing.Item) return json(404, { error: "Not found" });

      const admin = isAdmin(event);
      if (existing.Item.isTemplate && !admin) {
        return json(403, { error: "Templates are read-only. Fork this project to edit it." });
      }
      if (!existing.Item.isTemplate && existing.Item.sessionId !== sessionId && !admin) {
        return json(403, { error: "Not your project" });
      }

      const updated = {
        ...existing.Item,
        ...body,
        id: existing.Item.id,
        sessionId: existing.Item.sessionId,
        isTemplate: existing.Item.isTemplate,
        updatedAt: new Date().toISOString(),
      };
      await client.send(new PutCommand({ TableName: TABLE_NAME, Item: updated }));
      return json(200, updated);
    }

    if (idMatch && method === "DELETE") {
      const sessionId = getSessionId(event);
      if (!sessionId) return json(400, { error: "Missing X-Session-Id header" });

      const existing = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { id: idMatch[1] } })
      );
      if (!existing.Item) return json(404, { error: "Not found" });

      const admin = isAdmin(event);
      if (existing.Item.isTemplate && !admin) {
        return json(403, { error: "Templates cannot be deleted here" });
      }
      if (!existing.Item.isTemplate && existing.Item.sessionId !== sessionId && !admin) {
        return json(403, { error: "Not your project" });
      }

      await client.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { id: idMatch[1] } }));
      return json(204);
    }

    // POST /projects/{id}/fork
    const forkMatch = path.match(/^\/projects\/([^/]+)\/fork$/);
    if (forkMatch && method === "POST") {
      const sessionId = getSessionId(event);
      if (!sessionId) return json(400, { error: "Missing X-Session-Id header" });

      const source = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { id: forkMatch[1] } })
      );
      if (!source.Item) return json(404, { error: "Not found" });

      const now = new Date().toISOString();
      const forked = {
        ...source.Item,
        id: randomUUID(),
        sessionId,
        isTemplate: false,
        name: source.Item.name.replace(/^Example:\s*/, ""),
        createdAt: now,
        updatedAt: now,
      };
      await client.send(new PutCommand({ TableName: TABLE_NAME, Item: forked }));
      return json(201, forked);
    }

    // POST /templates (admin only)
    if (path === "/templates" && method === "POST") {
      if (!isAdmin(event)) return json(403, { error: "Admin only" });

      const now = new Date().toISOString();
      const template = {
        id: randomUUID(),
        sessionId: "TEMPLATE",
        isTemplate: true,
        name: body.name || "New example",
        address: body.address || null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        roofOutline: body.roofOutline ?? null,
        modules: body.modules ?? [],
        createdAt: now,
        updatedAt: now,
      };
      await client.send(new PutCommand({ TableName: TABLE_NAME, Item: template }));
      return json(201, template);
    }

    return json(404, { error: "No matching route" });
  } catch (err) {
    console.error(err);
    return json(500, { error: "Internal error" });
  }
};
