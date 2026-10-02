import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CVICHE_INBOUND_PREFIX, InboundMailStack } from "../lib/inbound-mail-stack";

const ENV = { account: "111111111111", region: "us-east-1" };

function ruleNames(context: Record<string, string>): string[] {
  const app = new App({ context });
  const template = Template.fromStack(new InboundMailStack(app, "Inbound", { env: ENV }));
  return Object.values(template.findResources("AWS::SES::ReceiptRule")).map(
    (r) => (r as { Properties: { Rule: { Name: string } } }).Properties.Rule.Name,
  );
}

describe("InboundMailStack", () => {
  it("omits the CViche rule without cvicheInboundBucket context", () => {
    expect(ruleNames({}).sort()).toEqual(["clips", "funding"]);
  });

  it("routes cv@ to CViche's bucket under its prefix, scanned", () => {
    const app = new App({ context: { cvicheInboundBucket: "example-cviche-bucket" } });
    const template = Template.fromStack(new InboundMailStack(app, "Inbound", { env: ENV }));
    template.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: {
        Name: "cviche-cv",
        Recipients: ["cv@scholars-mail.weill.cornell.edu"],
        ScanEnabled: true,
        Actions: [{ S3Action: { BucketName: "example-cviche-bucket", ObjectKeyPrefix: CVICHE_INBOUND_PREFIX } }],
      },
    });
  });
});
