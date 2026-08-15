// Real backend for the projects API — same contract as mock-server/server.ts,
// so the frontend's api/client.ts doesn't need to change when this replaces it.
// One Lambda, routed internally by HTTP method + path (see infra routes).

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME as string;

interface Project {
  id: string;
  sessionId: string;
  isTemplate: boolean;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  roofOutline: GeoJSON.Polygon | null;
  modules: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

function json(status: number, body?: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  };
}

function getSessionId(event: APIGatewayProxyEventV2): string | undefined {
  return event.headers?.["x-session-id"] ?? event.headers?.["X-Session-Id"];
}

function isAdmin(event: APIGatewayProxyEventV2): boolean {
  return event.headers?.["x-admin"] === "true";
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    if (path === "/projects" && method === "GET") {
      const sessionId = getSessionId(event);
      if (!sessionId) return json(400, { error: "Missing X-Session-Id header" });

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
      return json(200, [...(templates.Items ?? []), ...(mine.Items ?? [])]);
    }

    if (path === "/projects" && method === "POST") {
      const sessionId = getSessionId(event);
      if (!sessionId) return json(400, { error: "Missing X-Session-Id header" });

      const now = new Date().toISOString();
      const project: Project = {
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

      const updated: Project = {
        ...(existing.Item as Project),
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

    const forkMatch = path.match(/^\/projects\/([^/]+)\/fork$/);
    if (forkMatch && method === "POST") {
      const sessionId = getSessionId(event);
      if (!sessionId) return json(400, { error: "Missing X-Session-Id header" });

      const source = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { id: forkMatch[1] } })
      );
      if (!source.Item) return json(404, { error: "Not found" });

      const now = new Date().toISOString();
      const forked: Project = {
        ...(source.Item as Project),
        id: randomUUID(),
        sessionId,
        isTemplate: false,
        name: (source.Item.name as string).replace(/^Example:\s*/, ""),
        createdAt: now,
        updatedAt: now,
      };
      await client.send(new PutCommand({ TableName: TABLE_NAME, Item: forked }));
      return json(201, forked);
    }

    if (path === "/templates" && method === "POST") {
      if (!isAdmin(event)) return json(403, { error: "Admin only" });

      const now = new Date().toISOString();
      const template: Project = {
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