"use client"
import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export default function Header() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const router = useRouter();
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchSuggestions = async () => {
      if (!query) {
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }
      if(query.length < 3) {
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }
      
      setLoading(true);

      const res = await fetch(`/api/autocomplete?q=${encodeURIComponent(query)}`);
      const data = await res.json();

      setSuggestions(data);
      setShowSuggestions(data.length > 0);
      setLoading(false);
    };

    const delay = setTimeout(fetchSuggestions, 300);
    return () => clearTimeout(delay);
  }, [query]);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSuggestionClick = (id: string) => {
    console.log("Clicked suggestion with ID:", id); // Debug log
    setShowSuggestions(false);
    setQuery("");
    setSuggestions([]);
    router.push(`/display/${id}`);
  };

  return (
    <div className="relative">
      {/* Hidden checkboxes for CSS-only toggle functionality */}
      <input type="checkbox" id="search-toggle" className="peer/search hidden" />
      <input type="checkbox" id="mobile-menu-toggle" className="peer/menu hidden" />
      
      <header className="bg-gradient-to-r from-[#5A1414] via-[#4B0F0F] to-[#5A1414] text-white w-full shadow-lg">
        {/* Top Header */}
        <div className="max-w-screen-xl mx-auto px-4 py-3 md:py-4">
          <div className="flex justify-between items-center">
            {/* Left: Logo + Text */}
            <div className="flex items-center gap-3 md:gap-5 flex-1">
              <img
                src="/not.png"
                alt="not Logo"
                className="w-[50px] md:w-[50px] lg:w-[50px] mb-23"
              />

              <Link href="/" className="flex-shrink-0 transform hover:scale-105 transition-transform duration-200">
                <img
                  src="/vivo-logo.png"
                  alt="VIVO Logo"
                  className="object-contain w-[100px] md:w-[140px] lg:w-[186px] h-auto drop-shadow-lg"
                />
              </Link>

              <Link
                href="https://weill.cornell.edu/"
                className="hidden sm:block flex-shrink-0 transform hover:scale-105 transition-transform duration-200"
              >
                <img
                  src="/wcmc-white.png"
                  alt="wcmc Logo"
                  className="object-contain w-[140px] md:w-[200px] lg:w-[300px] h-auto drop-shadow-lg"
                />
              </Link>
            </div>

            {/* Desktop Search with Autocomplete */}
            <div className="hidden md:block relative" ref={searchRef}>
              <div className="relative">
                <input
                  type="text"
                  className="text-gray-900 bg-white px-4 py-2 border border-gray-300 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-80 lg:w-96 transition-colors duration-200 placeholder:text-gray-500"
                  placeholder="Search people, publications, appointments..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                />
                {loading && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="animate-spin h-4 w-4 border-2 border-orange-500 border-t-transparent rounded-full"></div>
                  </div>
                )}
              </div>

              {showSuggestions && suggestions.length > 0 && (
                <ul className="absolute z-50 w-full bg-white border border-gray-300 mt-1 rounded-md shadow-lg max-h-80 overflow-y-auto">
                  {suggestions.map((s: any, idx: number) => (
                    <li
                      key={idx}
                      className="px-4 py-3 hover:bg-orange-50 cursor-pointer border-b border-gray-100 last:border-b-0 text-gray-800 text-sm"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSuggestionClick(s.id);
                      }}
                    >
                      <div className="font-semibold">{s.name}</div>
                      {s.department && (
                        <div className="text-xs text-gray-600 mt-1">{s.department}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Mobile Icons */}
            <div className="flex md:hidden items-center gap-2">
              <label
                htmlFor="search-toggle"
                className="p-2.5 hover:bg-white/20 rounded-lg cursor-pointer transition-all duration-200 text-xl backdrop-blur-sm"
                aria-label="Toggle search"
              >
                🔍
              </label>
              <label
                htmlFor="mobile-menu-toggle"
                className="p-2.5 hover:bg-white/20 rounded-lg cursor-pointer text-xl transition-all duration-200 backdrop-blur-sm"
                aria-label="Toggle menu"
              >
                <span className="block peer-checked/menu:hidden">☰</span>
                <span className="hidden peer-checked/menu:block">✕</span>
              </label>
            </div>
          </div>

          {/* Mobile Search Bar */}
          <div className="hidden peer-checked/search:block md:hidden mt-3">
            <div className="relative" ref={searchRef}>
              <input
                type="text"
                placeholder="Search..."
                className="text-gray-900 bg-white px-4 py-2 border border-gray-300 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-full"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              />
              {loading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="animate-spin h-4 w-4 border-2 border-orange-500 border-t-transparent rounded-full"></div>
                </div>
              )}

              {showSuggestions && suggestions.length > 0 && (
                <ul className="absolute z-50 w-full bg-white border border-gray-300 mt-1 rounded-md shadow-lg max-h-60 overflow-y-auto">
                  {suggestions.map((s: any, idx: number) => (
                    <li
                      key={idx}
                      className="px-4 py-3 hover:bg-orange-50 cursor-pointer border-b border-gray-100 last:border-b-0 text-gray-800 text-sm"
                      onClick={() => handleSuggestionClick(s.id)}
                    >
                      <div className="font-semibold">{s.name}</div>
                      {s.department && (
                        <div className="text-xs text-gray-600 mt-1">{s.department}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Mobile WCMC Logo */}
          <div className="sm:hidden mt-3">
            <Link href="https://weill.cornell.edu/">
              <img
                src="/wcmc-white.png"
                alt="wcmc Logo"
                className="object-contain w-[180px] h-auto drop-shadow-lg"
              />
            </Link>
          </div>
        </div>

        {/* Desktop Navigation */}
        <nav className="hidden md:block bg-gradient-to-r from-gray-50 to-gray-100 border-t-2 border-orange-500/30">
          <div className="max-w-screen-xl mx-auto flex px-4 py-3 gap-1 text-sm">
            <Link 
              href="/" 
              className="px-4 py-2 font-semibold text-[#4B0F0F] bg-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 transform hover:-translate-y-0.5"
            >
              🏠 Home
            </Link>
            <Link 
              href="/people" 
              className="px-4 py-2 text-gray-700 hover:text-[#4B0F0F] hover:bg-white rounded-lg transition-all duration-200 transform hover:-translate-y-0.5"
            >
              👥 People
            </Link>
            <Link 
              href="#" 
              className="px-4 py-2 text-gray-700 hover:text-[#4B0F0F] hover:bg-white rounded-lg transition-all duration-200 transform hover:-translate-y-0.5"
            >
              🔬 Research
            </Link>
            <Link 
              href="#" 
              className="px-4 py-2 text-gray-700 hover:text-[#4B0F0F] hover:bg-white rounded-lg transition-all duration-200 transform hover:-translate-y-0.5"
            >
              💬 Support
            </Link>
          </div>
        </nav>
      </header>

      {/* Mobile Navigation Menu */}
      <nav className="hidden peer-checked/menu:block md:hidden bg-gradient-to-br from-gray-50 to-gray-100 border-t-2 border-orange-500/30 shadow-lg">
        <div className="px-4 py-4 space-y-2">
          <Link
            href="/"
            className="block font-semibold text-[#4B0F0F] bg-white py-3 px-4 rounded-lg shadow-sm hover:shadow-md transition-all duration-200 transform hover:translate-x-1"
          >
            🏠 Home
          </Link>
          <Link
            href="/people"
            className="block text-gray-700 py-3 px-4 hover:bg-white rounded-lg hover:text-[#4B0F0F] transition-all duration-200 transform hover:translate-x-1 hover:shadow-md"
          >
            👥 People
          </Link>
          <Link
            href="#"
            className="block text-gray-700 py-3 px-4 hover:bg-white rounded-lg hover:text-[#4B0F0F] transition-all duration-200 transform hover:translate-x-1 hover:shadow-md"
          >
            🔬 Research
          </Link>
          <Link
            href="#"
            className="block text-gray-700 py-3 px-4 hover:bg-white rounded-lg hover:text-[#4B0F0F] transition-all duration-200 transform hover:translate-x-1 hover:shadow-md"
          >
            💬 Support
          </Link>
        </div>
      </nav>
    </div>
  );
}