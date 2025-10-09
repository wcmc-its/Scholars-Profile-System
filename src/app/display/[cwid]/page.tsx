import Link from "next/link";
import { ddbDocClient } from "../../lib/dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import React from 'react';

interface DisplayPageProps {
  params: {
    cwid: string;
  };
}

type Education = {
  institution: string;
  institutionId: string;
  field: string | null;
  year: number;
  degree: string;
  personIdentifier: string;
  source: string;
};

interface Appointment {
  id: string;
  personIdentifier: string;
  title: string;
  orgUnit: string;
  orgUnitId: string;
  parentOrg: string;
  parentOrgId: string;
  startDate: string;
  endDate: string | null;
  isPrimary: boolean;
  sortOrder: number;
  source: string;
}

interface Publication {
  pmid: number;
  personIdentifier: string;
  title: string;
  journalTitle: string;
  publicationDate: string;
  publicationYear: number;
  publicationType: string;
  authorPosition: number;
  authorList: string[];
  doi: string | null;
  pmcid: string | null;
  citationCount: number;
  abstract: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  source: string;
}

interface Funding {
  id: string;
  personIdentifier: string;
  title: string;
  role: string;
  startDate: string;
  endDate: string;
  administeringOrg: string;
  sponsor: string;
  sponsorId: string;
  subawardSponsor: string | null;
  sponsorAwardId: string;
}

interface ConflictOfInterest {
  personIdentifier: string;
  category: string;
  company: string;
  description: string;
  year: number;
}

const formatDate = (dateString: string | Date | null | undefined) => {
  if (!dateString) return '';
  const year = new Date(dateString).getFullYear();
  return year;
};

export default async function DisplayPage({ params }: DisplayPageProps) {
  const { cwid } = params;

  const cwidData = await ddbDocClient.send(
    new GetCommand({
      TableName: "person",
      Key: { personIdentifier: cwid },
    })
  );

  const result = cwidData.Item;
  //console.log("Fetched profile data:", result);

  if (!result)
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 border border-gray-300 shadow-sm max-w-md w-full text-center">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Profile Not Found</h2>
          <p className="text-gray-600">No profile found for CWID: {cwid}</p>
        </div>
      </div>
    );

  const sections = [
    { id: "publications", title: "Publications" },
    { id: "research", title: "Research" },
    { id: "background", title: "Background" },
    { id: "contact", title: "Contact" },
    { id: "other", title: "Other" },
  ];

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="border-b-2 border-blue-900 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-6">
          <h1 className="text-3xl font-serif font-bold text-blue-900 mb-2">
            {result.profile.person.name.displayFirstLast}
          </h1>
          <p className="text-xl text-gray-700 font-medium">
            {result.profile.person.title}
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="bg-gray-100 border-b border-gray-300">
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex flex-wrap gap-1">
            {sections.map((section, index) => (
              <React.Fragment key={section.id}>
                <Link 
                  href={`#${section.id}`} 
                  className="px-4 py-3 text-sm font-medium text-blue-700 hover:text-blue-900 hover:bg-gray-200 transition-colors"
                >
                  {section.title}
                </Link>
                {index < sections.length - 1 && (
                  <span className="py-3 text-gray-400">|</span>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        
        {/* Profile Section */}
        <div className="mb-12">
          <div className="flex flex-col lg:flex-row gap-8">
            {/* Profile Image */}
            {result.profile.person.headshotUrl && (
              <div className="flex-shrink-0">
                <img
                  src={result.profile.person.headshotUrl}
                  alt={result.profile.person.name.displayFirstLast}
                  className="w-35 h-50 object-cover border border-gray-300 shadow-sm"
                />
              </div>
            )}

            {/* Appointments and Overview */}
            <div className="flex-1">
              {/* Appointments */}
              <div className="mb-8">
                <h2 className="text-lg font-semibold text-gray-900 mb-4 border-b border-gray-300 pb-2">
                  Appointments
                </h2>
                <div className="space-y-3">
                  {result.profile.appointments
                    .sort((a: Appointment, b: Appointment) => a.sortOrder - b.sortOrder)
                    .map((appointment: Appointment) => (
                      <div key={appointment.id} className="text-gray-800">
                        <div className="font-medium text-base leading-relaxed">
                          {appointment.title}
                        </div>
                        {appointment.orgUnit && (
                          <div className="text-blue-700 mt-1">
                            {appointment.orgUnit}
                          </div>
                        )}
                        {appointment.parentOrg && (
                          <div className="text-gray-600 mt-1">
                            {appointment.parentOrg}
                          </div>
                        )}
                        {appointment.startDate && (
                          <div className="text-sm text-gray-500 mt-1">
                            {formatDate(appointment.startDate)} - 
                            {appointment.endDate ? ` ${formatDate(appointment.endDate)}` : ' Present'}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </div>

              {/* Overview */}
              {result.profile.person.overview && (
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 mb-4 border-b border-gray-300 pb-2">
                    Overview
                  </h2>
                  <div 
                    className="prose prose-gray max-w-none text-gray-700 leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: result.profile.person.overview }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Publications Section */}
        <section id="publications" className="mb-12">
          <h2 className="text-2xl font-serif font-bold text-blue-900 mb-6 border-b-2 border-blue-900 pb-2">
            Publications
          </h2>
          {result.profile.publications && result.profile.publications.length > 0 ? (
            <div className="space-y-6">
              {result.profile.publications.map((pub: Publication, idx: number) => (
                <div key={pub.pmid || idx} className="border-l-4 border-blue-200 pl-4">
                  <h3 className="font-medium text-lg text-gray-900 leading-tight mb-2">
                    {pub.title}
                  </h3>
                  <p className="text-gray-600 italic mb-2">
                    <em>{pub.journalTitle}</em>. {pub.publicationYear}.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <span className="inline-block px-2 py-1 bg-gray-200 text-gray-700 text-xs font-medium rounded">
                      {pub.publicationType}
                    </span>
                    <span className="inline-block px-2 py-1 bg-blue-100 text-blue-800 text-xs font-medium rounded hover:bg-blue-200 cursor-pointer">
                      View Publication
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-600 italic">No publications available.</p>
          )}
        </section>

        {/* Research Section */}
        <section id="research" className="mb-12">
          <h2 className="text-2xl font-serif font-bold text-blue-900 mb-6 border-b-2 border-blue-900 pb-2">
            Research
          </h2>
          
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Funding Awards
          </h3>
          
          {result.profile.funding && result.profile.funding.length > 0 ? (
            <div className="space-y-4">
              {result.profile.funding.map((grant: Funding, idx: number) => (
                <div key={grant.id || idx} className="border border-gray-200 p-4 bg-gray-50">
                  <h4 className="font-medium text-blue-700 text-lg mb-2">
                    {grant.title}
                  </h4>
                  <p className="text-gray-700 mb-2">
                    <strong>Funding Organization:</strong> {grant.sponsor}
                  </p>
                  <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600">
                    <span>
                      <strong>Role:</strong> {grant.role}
                    </span>
                    <span>
                      <strong>Period:</strong> {new Date(grant.startDate).getFullYear()} - {new Date(grant.endDate).getFullYear()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-600 italic">No funding information available.</p>
          )}
        </section>

        {/* Background Section */}
        <section id="background" className="mb-12">
          <h2 className="text-2xl font-serif font-bold text-blue-900 mb-6 border-b-2 border-blue-900 pb-2">
            Background
          </h2>
          
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Education and Training
          </h3>
          
          <div className="space-y-3">
            {result.profile.education.map((edu: Education, index: number) => (
              <div key={index} className="flex flex-col sm:flex-row sm:items-center gap-2 text-gray-800">
                <div className="font-medium">
                  {edu.degree}
                </div>
                <div className="text-blue-700">
                  {edu.institution}
                </div>
                <div className="text-gray-500 text-sm">
                  ({edu.year})
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Contact Section */}
        <section id="contact" className="mb-12">
          <h2 className="text-2xl font-serif font-bold text-blue-900 mb-6 border-b-2 border-blue-900 pb-2">
            Contact Information
          </h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-semibold text-gray-900 mb-2">Full Name</h3>
              <p className="text-gray-700">
                {result.profile.person.name.displayFirstLast || "N/A"}
              </p>
            </div>
            
            <div>
              <h3 className="font-semibold text-gray-900 mb-2">Email</h3>
              <p className="text-blue-700">
                {result.profile.person.email || "N/A"}
              </p>
            </div>

            {result.profile.person.clinicalProfileUrl && (
              <div className="md:col-span-2">
                <h3 className="font-semibold text-gray-900 mb-2">webpage</h3>
                <Link
                  href={result.profile.person.clinicalProfileUrl}
                  target="_blank"
                  className="text-blue-700 hover:text-blue-900 underline"
                >
                  View Clinical Profile
                </Link>
              </div>
            )}
          </div>
        </section>

        {/* Other Section */}
        <section id="other" className="mb-12">
          <h2 className="text-2xl font-serif font-bold text-blue-900 mb-6 border-b-2 border-blue-900 pb-2">
           External Relationships
          </h2>
          
          <div className="bg-yellow-50 border border-yellow-200 p-4 mb-6">
           
            <p className="text-sm text-gray-700 leading-relaxed">
              Relationships and collaborations with for-profit and not-for-profit organizations are of vital importance to our faculty because these exchanges of scientific information foster innovation. As experts in their fields, WCM physicians and scientists are sought after by many organizations to consult and educate. WCM and its faculty make this information available to the public, thus creating a transparent environment.
            </p>
          </div>

          {result.profile.conflictsOfInterest && result.profile.conflictsOfInterest.length > 0 ? (
            <div>
              <h3 className="font-semibold text-gray-900 mb-4">Conflicts of Interest</h3>
              <div className="space-y-2">
                {result.profile.conflictsOfInterest.map((conflict: any, idx: number) => (
                  <div key={idx} className="border border-gray-200 p-3 bg-gray-50">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <span className="font-medium text-gray-900 text-sm">
                        {conflict.category}:
                      </span>
                      <span className="text-gray-700">
                        {conflict.company}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-gray-600 italic">No conflicts of interest reported.</p>
          )}
        </section>

        
      </div>
    </div>
  );
}
