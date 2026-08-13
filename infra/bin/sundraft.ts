#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { SunDraftStack } from "../lib/sundraft-stack";

const app = new cdk.App();
new SunDraftStack(app, "SunDraftStack", {
  /* env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }, */
});
