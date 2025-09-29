import Link from "next/link";

export default function Header() {
  return (
    <div className="relative">
      {/* Hidden checkboxes for CSS-only toggle functionality */}
      <input type="checkbox" id="search-toggle" className="peer/search hidden" />
      <input type="checkbox" id="mobile-menu-toggle" className="peer/menu hidden" />
      
      <header className="bg-[#4B0F0F] text-white w-full">
        {/* Top Header */}
        <div className="max-w-screen-xl mx-auto px-4 py-3">
          <div className="flex justify-between items-center">
            {/* Left: Logo + Text */}
            <div className="flex items-center gap-3 md:gap-5 flex-1">
              <Link href="/" className="flex-shrink-0">
                <img
                  src="/vivo-logo.png"
                  alt="VIVO Logo"
                  className="object-contain w-[100px] md:w-[140px] lg:w-[186px] h-auto"
                />
              </Link>

              <Link
                href="https://weill.cornell.edu/"
                className="hidden sm:block flex-shrink-0"
              >
                <img
                  src="/wcmc-white.png"
                  alt="wcmc Logo"
                  className="object-contain w-[140px] md:w-[200px] lg:w-[300px] h-auto"
                />
              </Link>
            </div>

            {/* Desktop: Index & Log in Links */}
            <div className="hidden lg:flex items-center gap-4 mr-4">
              <Link href="#" className="text-sm hover:underline whitespace-nowrap">
                Index
              </Link>
              <Link href="#" className="text-sm hover:underline whitespace-nowrap">
                Log in
              </Link>
            </div>

            {/* Desktop Search */}
            <div className="hidden md:flex items-center gap-3">
              <input
                type="text"
                placeholder="Search..."
                className="text-black bg-white px-3 py-1.5 rounded border border-gray-300 focus:outline-none focus:ring-2 focus:ring-orange-500 w-40 lg:w-48"
              />
              <button className="bg-gradient-to-r from-orange-600 to-red-700 px-4 py-1.5 text-white rounded hover:from-orange-700 hover:to-red-800 transition whitespace-nowrap">
                Search
              </button>
            </div>

            {/* Mobile Icons */}
            <div className="flex md:hidden items-center gap-2">
              <label
                htmlFor="search-toggle"
                className="p-2 hover:bg-white/10 rounded cursor-pointer"
                aria-label="Toggle search"
              >
                🔍
              </label>
              <label
                htmlFor="mobile-menu-toggle"
                className="p-2 hover:bg-white/10 rounded cursor-pointer text-xl"
                aria-label="Toggle menu"
              >
                <span className="block peer-checked/menu:hidden">☰</span>
                <span className="hidden peer-checked/menu:block">❌</span>
              </label>
            </div>
          </div>

          {/* Mobile Search Bar */}
          <div className="hidden peer-checked/search:flex md:hidden mt-3 items-center gap-2">
            <input
              type="text"
              placeholder="Search..."
              className="text-black bg-white px-3 py-2 rounded border border-gray-300 focus:outline-none focus:ring-2 focus:ring-orange-500 flex-1"
            />
            <button className="bg-gradient-to-r from-orange-600 to-red-700 px-4 py-2 text-white rounded hover:from-orange-700 hover:to-red-800 transition whitespace-nowrap">
              Search
            </button>
          </div>

          {/* Mobile WCMC Logo */}
          <div className="sm:hidden mt-3">
            <Link href="https://weill.cornell.edu/">
              <img
                src="/wcmc-white.png"
                alt="wcmc Logo"
                className="object-contain w-[180px] h-auto"
              />
            </Link>
          </div>
        </div>

        {/* Desktop Navigation */}
        <nav className="hidden md:block bg-gray-100 border-t border-gray-800">
          <div className="max-w-screen-xl mx-auto flex px-4 py-2.5 space-x-6 text-sm text-gray-800">
            <Link href="/" className="font-semibold text-[#4B0F0F] hover:underline">
              Home
            </Link>
            <Link href="/people" className="hover:text-[#4B0F0F] hover:underline">
              People
            </Link>
            <Link href="#" className="hover:text-[#4B0F0F] hover:underline">
              Organizations
            </Link>
            <Link href="#" className="hover:text-[#4B0F0F] hover:underline">
              Research
            </Link>
            <Link href="#" className="hover:text-[#4B0F0F] hover:underline">
              Support
            </Link>
          </div>
        </nav>
      </header>

      {/* Mobile Navigation Menu - Outside header so peer selector works */}
      <nav className="hidden peer-checked/menu:block md:hidden bg-gray-100 border-t border-gray-800">
        <div className="px-4 py-3 space-y-3">
          <Link
            href="/"
            className="block font-semibold text-[#4B0F0F] py-2 hover:bg-gray-200 px-3 rounded"
          >
            Home
          </Link>
          <Link
            href="/people"
            className="block text-gray-800 py-2 hover:bg-gray-200 px-3 rounded hover:text-[#4B0F0F]"
          >
            People
          </Link>
          <Link
            href="#"
            className="block text-gray-800 py-2 hover:bg-gray-200 px-3 rounded hover:text-[#4B0F0F]"
          >
            Organizations
          </Link>
          <Link
            href="#"
            className="block text-gray-800 py-2 hover:bg-gray-200 px-3 rounded hover:text-[#4B0F0F]"
          >
            Research
          </Link>
          <Link
            href="#"
            className="block text-gray-800 py-2 hover:bg-gray-200 px-3 rounded hover:text-[#4B0F0F]"
          >
            Support
          </Link>

          {/* Mobile: Index & Log in Links */}
          <div className="border-t border-gray-300 pt-3 mt-3 space-y-3">
            <Link href="#" className="block text-gray-800 py-2 hover:bg-gray-200 px-3 rounded hover:text-[#4B0F0F]">
              Index
            </Link>
            <Link href="#" className="block text-gray-800 py-2 hover:bg-gray-200 px-3 rounded hover:text-[#4B0F0F]">
              Log in
            </Link>
          </div>
        </div>
      </nav>
    </div>
  );
}