'use client';

import Image from 'next/image';
import Link from 'next/link';

export default function Home() {
  return (
    <div className="bg-[#f5f5f2] min-h-screen text-gray-800">

      {/* Welcome Section */}
      <div className="flex flex-col">
        <section className="bg-white p-6 rounded shadow mb-6">
          <h2 className="text-xl font-semibold mb-2">
            Welcome to the VIVO for Weill Cornell Medical College and the CTSC
          </h2>
          <p className="mb-4 text-sm text-[18px]">
            VIVO is a research-focused discovery tool that enables collaboration among scientists across all disciplines. VIVO contains information about researchers associated with the{' '}
            <a href="https://ctscweb.weill.cornell.edu/" className="text-[#7e2930] text-[18px]" target="_blank" rel="noopener noreferrer">Clinical and Translational Science Center</a>.
          </p>

          <div className="flex justify-between items-start gap-6">
            <p className="text-sm font-medium">
              Browse or search for people, departments, courses, grants, and publications.
            </p>
            <Link href="https://ctscweb.weill.cornell.edu/" target="_blank" rel="noopener noreferrer">
            <Image
              src="/ctsc-logo.png" 
              alt="CTSC Logo"
              width={120}
              height={60}
              className="object-contain"
            />
            </Link>
          </div>
        </section>
        </div>
      <div className="max-w-screen-xl mx-auto px-4 py-10">

        

        {/* People Section */}
        <div className="flex flex-col lg:flex-row gap-4">

          {/* Sidebar - Only People tab */}
          {/* <aside className="w-full lg:w-1/4 bg-gray-100 border p-4">
            <Link href="/people">
              <div className="flex justify-between items-center px-2 py-1 bg-white font-medium border-l-4 border-[#4B0F0F] text-[#4B0F0F]">
                <span>People</span>
                <span className="text-gray-500">(8,995)</span>
              </div>
            </Link>
          </aside> */}

          {/* Right - Roles list with bar style count indicators */}
          {/* <section className="w-full lg:w-3/4 bg-white border p-4">
            {[
              'Adjunct Faculty',
              'Courtesy Faculty',
              'Faculty Member',
              'Faculty Member Emeritus',
              'Fellow',
              'Full-Time WCMC Faculty',
              'Instructor',
              'Lecturer',
              'Non-Academic',
              'Non-Faculty Academic',
              'Part-Time WCMC Faculty',
              'Person',
              'Postdoc',
              'Voluntary Faculty',
            ].map((role, index) => (
              <div
                key={index}
                className="flex justify-between items-center py-1 text-sm border-b"
              >
                <span>{role}</span>
                <div className="h-3 bg-gray-400 rounded" style={{ width: `${(Math.random() * 80 + 20).toFixed(0)}px` }} />
              </div>
            ))}
          </section> */}
        </div>
      </div>
    </div>
  );
}
