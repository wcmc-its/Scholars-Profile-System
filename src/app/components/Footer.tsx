export default function Footer() {
  return (
    <footer className="bg-white border-t border-gray-200 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-col sm:flex-row items-center justify-center gap-2 text-sm text-gray-600">
          <span className="font-medium">©2025 VIVO Project</span>
          <span className="hidden sm:inline text-gray-400">|</span>
          <a 
            href="#" 
            className="text-gray-600 hover:text-gray-900 underline underline-offset-2 transition-colors duration-200"
          >
            Terms of Use
          </a>
          <span className="hidden sm:inline text-gray-400">|</span>
          <span className="flex items-center gap-1">
            Powered by 
            <a 
              href="https://vivoweb.org/" 
              className="text-blue-600 hover:text-blue-800 underline underline-offset-2 font-medium transition-colors duration-200"
              target="_blank"
              rel="noopener noreferrer"
            >
              VIVO
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}