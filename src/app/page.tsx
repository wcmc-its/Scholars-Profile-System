// app/page.tsx
// working version with welcome section and conditional search results
import Image from 'next/image';
import Link from 'next/link';

export default async function Home({
  searchParams,
}: {
  searchParams?: { q?: string };
}) {
  const query = searchParams?.q || "";
  let results: any[] = [];

  // Fetch search results if query exists
  if (query) {
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/search?q=${encodeURIComponent(
          query
        )}`,
        {
          cache: "no-store",
        }
      );

      if (res.ok) {
        results = await res.json();
      } else {
        console.error("API error:", await res.text());
      }
    } catch (err) {
      console.error("Error calling API:", err);
    }
  }

  return (
    <div className="bg-[#f5f5f2] min-h-screen text-gray-800">

      {/* Welcome Section */}
      <div className="flex flex-col">
        <section className="bg-white p-6 rounded shadow mb-6">
          <h2 className="text-xl font-semibold mb-2">
            Welcome to the VIVO for Weill Cornell Medical College and the CTSC
          </h2>
          <article>
            <Link href="https://ctscweb.weill.cornell.edu/" target="_blank" rel="noopener noreferrer">
              <Image
                src="/ctsc-logo.png" 
                alt="CTSC Logo"
                width={120}
                height={80}
                className='float-right'
              />
            </Link>
            <p>
              VIVO is a research-focused discovery tool that enables collaboration among scientists across all disciplines. VIVO contains information about researchers associated with the{' '}
              <a href="https://ctscweb.weill.cornell.edu/" className="text-[#7e2930] text-[18px]" target="_blank" rel="noopener noreferrer">Clinical and Translational Science Center</a>.
            </p>
          
            <p className='text-black mt-10 mb-8 text-2xl'>
              Browse or search for people, departments, courses, grants, and publications.
            </p>
          </article>
        </section>
      </div>

      {/* Search Results Section - Only shows when there's a search query */}
      {query && (
        <div className="max-w-screen-xl mx-auto px-4 mb-10">
          <section className="bg-white p-6 rounded shadow">
            <h2 className="text-2xl font-bold mb-4">
              Search Results for "{query}"
            </h2>

            {results.length === 0 ? (
              <p className="text-gray-500 text-center py-8">
                No search results found.
              </p>
            ) : (
              <ul className="space-y-4">
                {results.map((person: any, idx) => (
                  <li key={idx} className="p-4 border rounded shadow hover:bg-gray-50">
                    <h3 className="font-semibold text-lg">
                      {person.person.name.displayFirstLast}
                    </h3>
                    <p className="text-gray-600">{person.person.title}</p>
                    <p className="text-gray-500">{person.person.email}</p>

                    {person.publications && person.publications.length > 0 && (
                      <div className="mt-2">
                        <p className="font-medium">Publications:</p>
                        <ul className="list-disc list-inside">
                          {person.publications.map((pub: any, i: number) => (
                            <li key={i}>{pub.title}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {/* Original Content Section */}
      <div className="max-w-screen-xl mx-auto px-4 py-10">
        <div className="flex flex-col lg:flex-row gap-4">
          {/* Your existing content can go here */}
        </div>
      </div>
    </div>
  );
}

//upto here


// 'use client';

// import Image from 'next/image';
// import Link from 'next/link';

// export default function Home() {
//   return (
//     <div className="bg-[#f5f5f2] min-h-screen text-gray-800">

//       {/* Welcome Section */}
//       <div className="flex flex-col">
//         <section className="bg-white p-6 rounded shadow mb-6">
//           <h2 className="text-xl font-semibold mb-2">
//             Welcome to the VIVO for Weill Cornell Medical College and the CTSC
//           </h2>
//           <article>
//             <Link href="https://ctscweb.weill.cornell.edu/" target="_blank" rel="noopener noreferrer">
//             <Image
//               src="/ctsc-logo.png" 
//               alt="CTSC Logo"
//               width={120}
//               height={80}
//               className='float-right'
//             />
//             </Link>
//             <p>
//             VIVO is a research-focused discovery tool that enables collaboration among scientists across all disciplines. VIVO contains information about researchers associated with the{' '}
//             <a href="https://ctscweb.weill.cornell.edu/" className="text-[#7e2930] text-[18px]" target="_blank" rel="noopener noreferrer">Clinical and Translational Science Center</a>.
//           </p>
          
//             {/* <div className="flex justify-between items-start gap-6"> */}
//             <p className='text-black mt-10 mb-8 text-2xl'>
//               Browse or search for people, departments, courses, grants, and publications.
//             </p>
//           {/* </div> */}
//           </article>
        
          
//         </section>
//         </div>
//       <div className="max-w-screen-xl mx-auto px-4 py-10">

        

//         {/* People Section */}
//         <div className="flex flex-col lg:flex-row gap-4">

//           {/* Sidebar - Only People tab */}
//           {/* <aside className="w-full lg:w-1/4 bg-gray-100 border p-4">
//             <Link href="/people">
//               <div className="flex justify-between items-center px-2 py-1 bg-white font-medium border-l-4 border-[#4B0F0F] text-[#4B0F0F]">
//                 <span>People</span>
//                 <span className="text-gray-500">(8,995)</span>
//               </div>
//             </Link>
//           </aside> */}

//           {/* Right - Roles list with bar style count indicators */}
//           {/* <section className="w-full lg:w-3/4 bg-white border p-4">
//             {[
//               'Adjunct Faculty',
//               'Courtesy Faculty',
//               'Faculty Member',
//               'Faculty Member Emeritus',
//               'Fellow',
//               'Full-Time WCMC Faculty',
//               'Instructor',
//               'Lecturer',
//               'Non-Academic',
//               'Non-Faculty Academic',
//               'Part-Time WCMC Faculty',
//               'Person',
//               'Postdoc',
//               'Voluntary Faculty',
//             ].map((role, index) => (
//               <div
//                 key={index}
//                 className="flex justify-between items-center py-1 text-sm border-b"
//               >
//                 <span>{role}</span>
//                 <div className="h-3 bg-gray-400 rounded" style={{ width: `${(Math.random() * 80 + 20).toFixed(0)}px` }} />
//               </div>
//             ))}
//           </section> */}
//         </div>
//       </div>
//     </div>
//   );
// }

// // // "use client";

// // // import { useState } from "react";

// // // export default function Home() {
// // //   const [query, setQuery] = useState("");
// // //   const [results, setResults] = useState<any[]>([]);
// // //   const [loading, setLoading] = useState(false);

// // //   const handleSearch = async () => {
// // //     setLoading(true);

// // //     // fetch from your API route
// // //     const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
// // //     const data = await res.json();

    
// // //     const hits = Array.isArray(data) ? data : data.hits?.hits?.map((hit: any) => hit._source) || [];
// // //     setResults(hits);

// // //     setLoading(false);
// // //   };

// // //   return (
// // //     <div className="p-8 max-w-5xl mx-auto">
// // //       <h1 className="text-3xl font-bold mb-4">OpenSearch People Search</h1>

// // //       <div className="flex gap-2 mb-6">
// // //         <input
// // //           type="text"
// // //           className="flex-1 p-2 border rounded shadow"
// // //           placeholder="Search people, publications, appointments..."
// // //           value={query}
// // //           onChange={(e) => setQuery(e.target.value)}
// // //         />
// // //         <button
// // //           className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
// // //           onClick={handleSearch}
// // //         >
// // //           Search
// // //         </button>
// // //       </div>

// // //       {loading && <p>Loading...</p>}

// // //       <ul className="space-y-4">
// // //         {results.map((person: any, idx) => (
// // //           <li key={idx} className="p-4 border rounded shadow hover:bg-gray-50">
// // //             <h2 className="font-semibold text-lg">{person.person.name.displayFirstLast}</h2>
// // //             <p className="text-gray-600">{person.person.title}</p>
// // //             <p className="text-gray-500">{person.person.email}</p>

// // //             {person.publications && person.publications.length > 0 && (
// // //               <div className="mt-2">
// // //                 <p className="font-medium">Publications:</p>
// // //                 <ul className="list-disc list-inside">
// // //                   {person.publications.map((pub: any, i: number) => (
// // //                     <li key={i}>{pub.title}</li>
// // //                   ))}
// // //                 </ul>
// // //               </div>
// // //             )}
// // //           </li>
// // //         ))}
// // //       </ul>
// // //     </div>
// // //   );
// // // }

// // // app/page.tsx or wherever your server component is
// // import React from "react";

// // export default async function Home({
// //   searchParams,
// // }: {
// //   searchParams?: { q?: string };
// // }) {
// //   const query = searchParams?.q || "";
// //   let results: any[] = [];

// //   if (query) {
// //     try {
// //       // Call your own API route server-side
// //       const res = await fetch(
// //         `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/search?q=${encodeURIComponent(
// //           query
// //         )}`,
// //         {
// //           // server-side fetch doesn't need CORS
// //           cache: "no-store",
// //         }
// //       );

// //       if (res.ok) {
// //         results = await res.json();
// //       } else {
// //         console.error("API error:", await res.text());
// //       }
// //     } catch (err) {
// //       console.error("Error calling API:", err);
// //     }
// //   }

// //   return (
// //     <div className="p-8 max-w-5xl mx-auto">
// //       <h1 className="text-3xl font-bold mb-4">OpenSearch People Search</h1>

// //       <form className="flex gap-2 mb-6" method="GET">
// //         <input
// //           name="q"
// //           type="text"
// //           className="flex-1 p-2 border rounded shadow"
// //           placeholder="Search people, publications, appointments..."
// //           defaultValue={query}
// //         />
// //         <button
// //           type="submit"
// //           className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
// //         >
// //           Search
// //         </button>
// //       </form>

// //       {results.length === 0 && query && <p>No results found.</p>}

// //       <ul className="space-y-4">
// //         {results.map((person: any, idx) => (
// //           <li key={idx} className="p-4 border rounded shadow hover:bg-gray-50">
// //             <h2 className="font-semibold text-lg">
// //               {person.person.name.displayFirstLast}
// //             </h2>
// //             <p className="text-gray-600">{person.person.title}</p>
// //             <p className="text-gray-500">{person.person.email}</p>

// //             {person.publications && person.publications.length > 0 && (
// //               <div className="mt-2">
// //                 <p className="font-medium">Publications:</p>
// //                 <ul className="list-disc list-inside">
// //                   {person.publications.map((pub: any, i: number) => (
// //                     <li key={i}>{pub.title}</li>
// //                   ))}
// //                 </ul>
// //               </div>
// //             )}
// //           </li>
// //         ))}
// //       </ul>
// //     </div>
// //   );
// // }
