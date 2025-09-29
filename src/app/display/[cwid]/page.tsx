import { ddbDocClient } from "../../lib/dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

interface DisplayPageProps {
  params: {
    cwid: string;
  };
}

export default async function DisplayPage({ params }: DisplayPageProps) {
  const { cwid } = params;

  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: "person",
      Key: { personIdentifier: cwid },
    })
  );

  const profile = result.Item;

  if (!profile)
    return (
      <div className="flex items-center justify-center h-screen text-red-600 font-semibold">
        No profile found for CWID: {cwid}
      </div>
    );

  const sections = [
    { id: "Publications", title: "Publications" },
    { id: "Background", title: "Background" },
    { id: "Contact", title: "Contact" },
    { id: "Other", title: "Other" },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {/* Breadcrumbs */}
      <nav className="flex space-x-3 mb-8 text-sm font-medium">
        {sections.map((section, index) => (
          <div key={section.id} className="flex items-center">
            <a href={`#${section.id}`} className="text-blue-600 hover:underline">
              {section.title}
            </a>
            {index < sections.length - 1 && <span className="mx-2 text-gray-400">/</span>}
          </div>
        ))}
      </nav>

      {/* Profile Header */}
      <div className="flex items-center space-x-4 mb-6">
        {profile.headshotUrl && (
          <img
            src={profile.headshotUrl}
            alt={profile.name.displayFirstLast}
            className="w-24 h-34 rounded object-cover border-2 border-gray-200"
          />
        )}
        <div>
          <h1 className="text-2xl font-bold">{profile.name.displayFirstLast}</h1>
          <p className="text-gray-500">{profile.title}</p>
        </div>
      </div>

      {/* Section 1 - Publications */}
      <section
        id="Publications"
        className="mb-16 scroll-mt-24 border-b-2 border-b-amber-700 pb-6"
      >
        <h2 className="text-2xl font-bold mb-4">Publications</h2>
        <ul className="list-disc list-inside text-gray-700 space-y-2">
          {profile.publications?.map((pub: string, idx: number) => (
            <li key={idx}>{pub}</li>
          )) || <li>No publications available.</li>}
        </ul>
      </section>

      {/* Section 2 - Background */}
      <section
        id="Background"
        className="mb-18 scroll-mt-24 border-b-2 border-b-amber-700 pb-6"
      >
        <h2 className="text-2xl font-bold mb-12">Background</h2>
        <h3>education and training</h3>
        <p className="text-gray-700">
          {profile.overview ? (
            <div
              className="text-gray-700 prose prose-sm"
              dangerouslySetInnerHTML={{ __html: profile.overview }}
            />
          ) : (
            <p className="text-gray-700">No background information available.</p>
          )}
        </p>
      </section>

      {/* Section 3 - Contact */}
      <section
        id="Contact"
        className="mb-16 scroll-mt-24 border-b-2 border-b-amber-700 pb-6"
      >
        <h2 className="text-2xl font-bold mb-4">Contact</h2>
        <p className="text-gray-700">
          <span className="font-medium">Email:</span> {profile.email || "N/A"}
        </p>
        {profile.profileUrl && (
          <p className="text-gray-700">
            <span className="font-medium">Profile URL:</span>{" "}
            <a
              href={profile.profileUrl}
              target="_blank"
              className="text-blue-500 underline"
            >
              {profile.profileUrl}
            </a>
          </p>
        )}
        {profile.clinicalProfileUrl && (
          <p className="text-gray-700">
            <span className="font-medium">Clinical Profile:</span>{" "}
            <a
              href={profile.clinicalProfileUrl}
              target="_blank"
              className="text-blue-500 underline"
            >
              {profile.clinicalProfileUrl}
            </a>
          </p>
        )}
      </section>

      {/* Section 4 - Other */}
      <section
        id="Other"
        className="mb-16 scroll-mt-24 border-b-2 border-b-amber-700 pb-6"
      >
        <h2 className="text-2xl font-bold mb-4">Other</h2>
        <div className="flex flex-wrap gap-2">
          {profile.personTypes?.map((type: string) => (
            <span
              key={type}
              className="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded-full"
            >
              {type}
            </span>
          )) || <p className="text-gray-700">No additional types.</p>}
        </div>
      </section>
    </div>
  );
}
