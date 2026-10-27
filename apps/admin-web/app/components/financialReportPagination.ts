/** Split before rasterizing so long appendices never become one oversized canvas. */
export function paginateFinancialReport(source: HTMLElement): HTMLElement[] {
  const doc = source.ownerDocument;
  const pages: HTMLElement[] = [];
  const usableHeight = 980;
  const styles = source.querySelector("style")?.cloneNode(true);
  let heading: HTMLElement | null = null;
  let page: HTMLElement;
  function newPage(repeatHeading = false) {
    page = doc.createElement("main");
    page.className = "financial-export";
    page.style.width = "760px";
    page.style.maxWidth = "760px";
    if (styles) page.appendChild(styles.cloneNode(true));
    if (repeatHeading && heading) page.appendChild(heading.cloneNode(true));
    doc.body.appendChild(page);
    pages.push(page);
  }
  function overflows() { return page.getBoundingClientRect().height > usableHeight; }
  function appendBlock(original: Element) {
    if (original.tagName === "STYLE") return;
    if (original.tagName === "H2") {
      heading = original as HTMLElement;
      if (page.getBoundingClientRect().height > usableHeight - 110) newPage();
    }
    const block = original.cloneNode(true) as HTMLElement;
    page.appendChild(block);
    if (overflows() && page.children.length > (styles ? 2 : 1)) {
      block.remove();
      newPage(original.tagName !== "H2" && original.tagName !== "HEADER");
      page.appendChild(block);
    }
  }
  function appendTable(table: HTMLTableElement) {
    const template = table.cloneNode(false) as HTMLTableElement;
    if (table.tHead) template.appendChild(table.tHead.cloneNode(true));
    let current: HTMLTableElement;
    let body: HTMLTableSectionElement;
    function startTable() {
      current = template.cloneNode(true) as HTMLTableElement;
      body = doc.createElement("tbody");
      current.appendChild(body);
      page.appendChild(current);
    }
    startTable();
    for (const row of Array.from(table.tBodies).flatMap((section) => Array.from(section.rows))) {
      const copy = row.cloneNode(true) as HTMLTableRowElement;
      body!.appendChild(copy);
      if (overflows() && (body!.rows.length > 1 || page.children.length > (styles ? 2 : 1))) {
        copy.remove();
        if (!body!.rows.length) current!.remove();
        newPage(true);
        startTable();
        body!.appendChild(copy);
      }
    }
  }
  function walk(element: Element) {
    if (element.tagName === "TABLE") appendTable(element as HTMLTableElement);
    else if (element.tagName === "SECTION" || element.classList.contains("appendix-table")) {
      if (element.classList.contains("appendix") && page.getBoundingClientRect().height > 100) newPage();
      for (const child of Array.from(element.children)) walk(child);
    } else appendBlock(element);
  }
  source.style.display = "none";
  newPage();
  for (const child of Array.from(source.children)) walk(child);
  return pages.filter((item) => item.children.length > (styles ? 1 : 0));
}
