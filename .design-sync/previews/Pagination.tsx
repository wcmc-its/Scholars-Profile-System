import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "scholars-profile-system";

export function ScholarSearchResults() {
  return (
    <div className="p-4">
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href="/scholars?page=2" />
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="/scholars?page=1">1</PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="/scholars?page=2">2</PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="/scholars?page=3" isActive>
              3
            </PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationEllipsis />
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="/scholars?page=12">12</PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationNext href="/scholars?page=4" />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

export function FirstPageActive() {
  return (
    <div className="p-4">
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href="#" aria-disabled="true" className="pointer-events-none opacity-50" />
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="/publications?page=1" isActive>
              1
            </PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="/publications?page=2">2</PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="/publications?page=3">3</PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationNext href="/publications?page=2" />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
