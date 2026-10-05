import { App } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import {
  CVICHE_INBOUND_BUCKET_PARAM,
  CVICHE_INBOUND_PREFIX,
  InboundMailStack,
} from "../lib/inbound-mail-stack";

const ENV = { account: "111111111111", region: "us-east-1" };

function synth(): { stack: InboundMailStack; template: Template } {
  const stack = new InboundMailStack(new App(), "Inbound", { env: ENV });
  return { stack, template: Template.fromStack(stack) };
}

describe("InboundMailStack", () => {
  it("declares the clips, funding and cviche-cv rules", () => {
    const names = Object.values(synth().template.findResources("AWS::SES::ReceiptRule")).map(
      (r) => (r as { Properties: { Rule: { Name: string } } }).Properties.Rule.Name,
    );
    expect(names.sort()).toEqual(["clips", "cviche-cv", "funding"]);
  });

  it("routes cv@ to the bucket named by the SSM parameter, under its prefix, scanned", () => {
    const { template } = synth();
    const params = template.findParameters("*", {
      Type: "AWS::SSM::Parameter::Value<String>",
      Default: CVICHE_INBOUND_BUCKET_PARAM,
    });
    const paramIds = Object.keys(params);
    expect(paramIds).toHaveLength(1);
    template.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: {
        Name: "cviche-cv",
        Recipients: ["cv@scholars-mail.weill.cornell.edu"],
        ScanEnabled: true,
        Actions: [
          {
            S3Action: Match.objectEquals({
              BucketName: { Ref: paramIds[0] },
              ObjectKeyPrefix: CVICHE_INBOUND_PREFIX,
            }),
          },
        ],
      },
    });
  });

  it("acknowledges the imported-bucket permissions warning", () => {
    Annotations.fromStack(synth().stack).hasNoWarning("*", Match.stringLikeRegexp("imported bucket"));
  });
});
