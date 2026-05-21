/**
 * Resource attributes for the OTel SDK boot.
 *
 * Values are read from the environment at module-load time. The ADOT
 * collector copies `service.*` and `deployment.environment` straight into the
 * X-Ray service map, so a missing value will surface there as "unknown".
 */

export interface ResourceAttrs {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly deploymentEnvironment: string;
}

export function readResourceAttrs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResourceAttrs {
  return {
    serviceName: env.OTEL_SERVICE_NAME ?? "sps-app",
    serviceVersion: env.SPS_IMAGE_SHA ?? env.OTEL_SERVICE_VERSION ?? "unknown",
    deploymentEnvironment: env.SPS_ENV ?? env.NODE_ENV ?? "unknown",
  };
}

export function resourceAttributes(attrs: ResourceAttrs): Record<string, string> {
  return {
    "service.name": attrs.serviceName,
    "service.version": attrs.serviceVersion,
    "deployment.environment": attrs.deploymentEnvironment,
  };
}
