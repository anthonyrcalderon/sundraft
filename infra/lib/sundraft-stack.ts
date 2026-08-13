import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";

// This stack is written but not deployed yet — see the root README for why.
// Deploying costs nothing at demo scale (Lambda + DynamoDB are on AWS's
// permanent "Always Free" tier; HTTP API on API Gateway is free during the
// account's Free-plan window and near-free after), but it does require a
// real AWS account and credentials, which this sandbox doesn't have.

export class SunDraftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Single table, PK = project id. A GSI lets us list "my projects" by
    // session without a table scan. Templates have sessionId = "TEMPLATE"
    // (DynamoDB GSI keys can't be null) so they show up in every session's
    // "examples" query without needing a second table.
    const table = new dynamodb.Table(this, "ProjectsTable", {
      tableName: "SunDraftProjects",
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // don't lose demo data on stack teardown
    });

    table.addGlobalSecondaryIndex({
      indexName: "bySession",
      partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
    });

    const commonEnv = {
      TABLE_NAME: table.tableName,
    };

    const projectsFn = new lambda.Function(this, "ProjectsFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "projects.handler",
      code: lambda.Code.fromAsset("lambda"),
      environment: commonEnv,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
    });
    table.grantReadWriteData(projectsFn);

    const httpApi = new apigwv2.HttpApi(this, "SunDraftHttpApi", {
      apiName: "sundraft-api",
      corsPreflight: {
        allowHeaders: ["Content-Type", "X-Session-Id", "X-Admin"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowOrigins: ["*"], // tighten to the real frontend origin before going live
      },
    });

    const integration = new HttpLambdaIntegration(
      "ProjectsIntegration",
      projectsFn
    );

    // Routes mirror mock-server/server.js exactly, one Lambda handling all
    // of them (routed internally by method + path) to keep cold starts and
    // deploy surface small for a portfolio-scale project.
    httpApi.addRoutes({
      path: "/projects",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
    });
    httpApi.addRoutes({
      path: "/projects/{id}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration,
    });
    httpApi.addRoutes({
      path: "/projects/{id}/fork",
      methods: [apigwv2.HttpMethod.POST],
      integration,
    });
    httpApi.addRoutes({
      path: "/templates",
      methods: [apigwv2.HttpMethod.POST],
      integration,
    });

    new cdk.CfnOutput(this, "ApiUrl", {
      value: httpApi.apiEndpoint,
      description: "Set this as VITE_API_BASE_URL (+ '/') in the frontend once deployed",
    });
  }
}
