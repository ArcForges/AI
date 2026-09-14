// SPDX-License-Identifier: AGPL-3.0-only
import { type HelloParams, isRecord, parseParams } from "./hello";

export interface DeploymentIdentity {
  workerVersion: string;
  sourceCommit: string;
  buildVersion: string;
}

export interface VerifiedHelloParams {
  kind: "verified-hello";
  expected: DeploymentIdentity;
  hello: HelloParams;
}

export function parseWorkflowParams(value: unknown): {
  hello: HelloParams;
  expected?: DeploymentIdentity;
} {
  if (!isRecord(value) || value.kind !== "verified-hello") {
    return { hello: parseParams(value) };
  }
  const expected = value.expected;
  if (
    Object.keys(value).length !== 3 ||
    !isRecord(expected) ||
    Object.keys(expected).length !== 3 ||
    typeof expected.workerVersion !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(expected.workerVersion) ||
    typeof expected.sourceCommit !== "string" ||
    !/^(?:[0-9a-f]{40}|development)$/u.test(expected.sourceCommit) ||
    typeof expected.buildVersion !== "string" ||
    !/^[\w.-]{1,128}$/u.test(expected.buildVersion)
  ) {
    throw new Error("Expected a complete deployment identity.");
  }
  return {
    hello: parseParams(value.hello),
    expected: {
      workerVersion: expected.workerVersion,
      sourceCommit: expected.sourceCommit,
      buildVersion: expected.buildVersion,
    },
  };
}

export function matchesDeployment(actual: DeploymentIdentity, expected: DeploymentIdentity) {
  return (
    actual.workerVersion === expected.workerVersion &&
    actual.sourceCommit === expected.sourceCommit &&
    actual.buildVersion === expected.buildVersion
  );
}
