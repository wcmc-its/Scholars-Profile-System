'use client';

import { useState, useMemo } from 'react';
import Link from "next/link";

// Type definitions
interface Faculty {
  id: number;
  cwid:string;
  name: string;
  title: string;
  category: string;
  avatar: string | null;
}

interface Category {
  name: string;
  count: number;
}
// Custom SVG icons to replace lucide-react


const UserIcon = () => (
  <img
            src="https://directory.weill.cornell.edu/api/v1/person/profile/ccole.png"
            alt="Curtis L Cole"
            className="w-40 h-20 sm:w-30 sm:h-22 rounded object-cover border-2 border-gray-200 flex-shrink-0 mx-auto sm:mx-0"
          />
);

const ChevronRightIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
  </svg>
);

// Sample JSON data structure based on your image
const facultyData: Faculty[] = [
  {
    id: 1,
    cwid:"ccole",
    name: "Curtis L Cole",
    title: "Vice President and Chief Global Information Officer",
    category: "Adjunct Faculty",
    avatar: null
  },
  {
    id: 2,
    cwid:"ccole",
    name: "Curtis L Cole",
    title: "Vice President and Chief Global Information Officer",
    category: "Adjunct Faculty",
    avatar: null
  },
  {
    id: 3,
    cwid:"cwid-sia2006",
    name: "Abdelmoneim, Ahmed",
    title: "Assistant Professor of Clinical Radiology",
    category: "Faculty Member",
    avatar: null
  },
  {
    id: 4,
     cwid:"cwid-sia2006",
    name: "Anderson, Michael",
    title: "Professor of Internal Medicine",
    category: "Faculty Member",
    avatar: null
  },
  {
    id: 5,
    cwid:"cwid-sia2006",
    name: "Brown, Sarah",
    title: "Associate Professor of Pediatrics",
    category: "Faculty Member",
    avatar: null
  },
];

// const categories: Category[] = [
//   { name: "Adjunct Faculty", count: 363 },
//   { name: "Courtesy Faculty", count: 159 },
//   { name: "Faculty Member", count: 7071 },
//   { name: "Faculty Member Emeritus", count: 137 },
//   { name: "Fellow", count: 97 },
//   { name: "Full-Time WCMC Faculty", count: 2208 },
//   { name: "Instructor", count: 964 },
//   { name: "Lecturer", count: 31 },
//   { name: "Non-Academic", count: 869 },
//   { name: "Non-Faculty Academic", count: 214 },
//   { name: "Part-Time WCMC Faculty", count: 176 },
//   { name: "Person", count: 8995 }
// ];

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export default function PeoplePage() {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedLetter, setSelectedLetter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  
  const itemsPerPage = 10;

  // Filter faculty data based on selected filters
  const filteredFaculty = useMemo(() => {
    let filtered = facultyData;

    // Filter by search query
    if (searchQuery) {
      filtered = filtered.filter(faculty =>
        faculty.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        faculty.title.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Filter by category
    if (selectedCategory !== "all") {
      filtered = filtered.filter(faculty => faculty.category === selectedCategory);
    }

    // Filter by first letter
    if (selectedLetter !== "all") {
      filtered = filtered.filter(faculty =>
        faculty.name.charAt(0).toUpperCase() === selectedLetter
      );
    }

    return filtered;
  }, [selectedCategory, selectedLetter, searchQuery]);

  // Pagination
  const totalPages = Math.ceil(filteredFaculty.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedFaculty = filteredFaculty.slice(startIndex, startIndex + itemsPerPage);

  // Reset to first page when filters change
  const handleFilterChange = (type: 'category' | 'letter', value: string) => {
    setCurrentPage(1);
    if (type === "category") setSelectedCategory(value);
    if (type === "letter") setSelectedLetter(value);
  };

  const FacultyCard = ({ faculty }: { faculty: Faculty }) => (
    <div className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-start space-x-4">
        <div className="flex-shrink-0">
          <div className="w-16 h-16 bg-gradient-to-br from-orange-400 to-orange-600 rounded-lg flex items-center justify-center text-white">
            <UserIcon />
          </div>
        </div>
        <div className="flex-1 min-w-0">
            <Link
            href={`/display/${faculty.cwid}`}
            className="hover:underline"
          >
            {faculty.name}
          </Link>

          {/* <h3 className="text-lg font-semibold text-gray-900 mb-1">
            {faculty.name}
          </h3> */}
          
          <p className="text-sm text-gray-600 leading-relaxed">
            {faculty.title}
          </p>
          <span className="inline-block mt-2 px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
            {faculty.category}
          </span>
        </div>
        <div className="text-gray-400">
          <ChevronRightIcon />
        </div>
      </div>
    </div>
  );

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">People</h1>
        
        {/* Search Bar */}
        <div className="relative mb-6">
          <div className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400">
          
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Sidebar Filters */}
        <div className="lg:w-1/4">
          <div className="bg-white rounded-lg border border-gray-200 p-6 sticky top-4">
           
            
            {/* Category Filter */}
            <div className="space-y-2 mb-6">
              <button
                onClick={() => handleFilterChange("category", "all")}
                className={`w-full text-left px-3 py-2 rounded transition-colors ${
                  selectedCategory === "all" 
                    ? "bg-orange-100 text-orange-800" 
                    : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                <span className="flex items-center justify-between">
                  <span>all</span>
                  <span className="text-sm text-gray-500">({facultyData.length})</span>
                </span>
              </button>
              
              {/* {categories.map((category) => (
                <button
                  key={category.name}
                  onClick={() => handleFilterChange("category", category.name)}
                  className={`w-full text-left px-3 py-2 rounded transition-colors ${
                    selectedCategory === category.name 
                      ? "bg-orange-100 text-orange-800" 
                      : "text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  <span className="flex items-center justify-between">
                    <span className="text-sm">{category.name}</span>
                    <span className="text-sm text-gray-500">({category.count})</span>
                  </span>
                </button>
              ))} */}
            </div>

           
          </div>
        </div>

        {/* Main Content */}
        <div className="lg:w-3/4">
          {/* Alphabet Navigation */}
          <div className="mb-6 bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => handleFilterChange("letter", "all")}
                className={`px-2 py-1 text-sm rounded transition-colors ${
                  selectedLetter === "all" 
                    ? "bg-orange-500 text-white" 
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                all
              </button>
              {alphabet.map((letter) => (
                <button
                  key={letter}
                  onClick={() => handleFilterChange("letter", letter)}
                  className={`px-2 py-1 text-sm rounded transition-colors ${
                    selectedLetter === letter 
                      ? "bg-orange-500 text-white" 
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {letter}
                </button>
              ))}
            </div>
          </div>

          {/* Pagination Top */}
          {totalPages > 1 && (
            <div className="mb-6">
              <div className="flex items-center space-x-2">
                <span className="text-gray-500 text-sm">page</span>
                {[...Array(Math.min(totalPages, 13))].map((_, index) => {
                  const page = index + 1;
                  return (
                    <button
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      className={`px-3 py-1 text-sm rounded transition-colors ${
                        currentPage === page
                          ? "bg-orange-500 text-white"
                          : "text-gray-600 hover:bg-gray-100"
                      }`}
                    >
                      {page}
                    </button>
                  );
                })}
                {totalPages > 13 && (
                  <span className="px-2 py-1 text-gray-500 text-sm">...</span>
                )}
              </div>
            </div>
          )}

          {/* Faculty Grid */}
          <div className="space-y-4 mb-8">
            {paginatedFaculty.length > 0 ? (
              paginatedFaculty.map((faculty) => (
                <FacultyCard key={faculty.id} faculty={faculty} />
              ))
            ) : (
              <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
                <div className="w-16 h-16 text-gray-300 mx-auto mb-4 flex items-center justify-center">
                  <UserIcon />
                </div>
                <p className="text-gray-500 text-lg">No faculty members found</p>
                <p className="text-gray-400">Try adjusting your search or filters</p>
              </div>
            )}
          </div>

          {/* Results Info */}
          <div className="text-center text-gray-600 text-sm">
            Showing {startIndex + 1}-{Math.min(startIndex + itemsPerPage, filteredFaculty.length)} of {filteredFaculty.length} results
          </div>
        </div>
      </div>
    </div>
  );
}