import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
  Button,
} from "scholars-profile-system";

export function ScholarProfileSummary() {
  return (
    <div className="p-4" style={{ width: 380 }}>
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Dr. Elena Vasquez, MD, PhD</CardTitle>
          <CardDescription>
            Associate Professor of Cardiology &middot; Weill Cornell Medicine
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm">
              View profile
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Research focus: heart failure pharmacogenomics and outcomes in
            underrepresented populations. Principal investigator on NIH grant
            5R01HL149135, &ldquo;Genomic Predictors of Response to Guideline-
            Directed Medical Therapy in Heart Failure.&rdquo;
          </p>
        </CardContent>
        <CardFooter className="border-t justify-between">
          <span className="text-xs text-muted-foreground">
            42 publications &middot; 3 active grants
          </span>
          <Button size="sm">Contact</Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export function CompactGrantCard() {
  return (
    <div className="p-4" style={{ width: 320 }}>
      <Card className="gap-3 py-4">
        <CardHeader>
          <CardTitle className="text-sm">5R01CA219442</CardTitle>
          <CardDescription>
            Molecular Mechanisms of Chemoresistance in Pancreatic Cancer
          </CardDescription>
        </CardHeader>
        <CardContent>
          <span className="text-xs text-muted-foreground">
            NIH/NCI &middot; $2.1M &middot; 2023&ndash;2028
          </span>
        </CardContent>
      </Card>
    </div>
  );
}
