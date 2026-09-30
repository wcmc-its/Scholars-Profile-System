import { Alert, AlertTitle, AlertDescription } from "scholars-profile-system";

export function SaveFailure() {
  return (
    <div className="p-4" style={{ width: 380 }}>
      <Alert variant="destructive">
        <AlertTitle>Unable to save profile</AlertTitle>
        <AlertDescription>
          <p>
            Your changes to Dr. Elena Vasquez&rsquo;s publication list could
            not be saved. Check your connection and try again.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function SuperuserNotice() {
  return (
    <div className="p-4" style={{ width: 380 }}>
      <Alert variant="info">
        <AlertTitle>Viewing as superuser</AlertTitle>
        <AlertDescription>
          <p>
            You are editing this profile on behalf of Dr. Rajesh Patel,
            Department of Cardiology. Changes are logged for audit review.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
