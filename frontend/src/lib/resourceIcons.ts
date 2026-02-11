// Unified resource icons for consistent usage across components
import figmaIcon from "../assets/figma.svg";
import githubIcon from "../assets/github.svg";
import notionIcon from "../assets/notion.svg";
import linkIcon from "../assets/link.svg";

export type ResourceLinkType = "figma" | "notion" | "github_issue" | "github_pr" | "url";

export interface ResourceIconInfo {
  src: string;
  alt: string;
  className: string;  // CSS class suffix (e.g., "--figma")
}

export function getResourceIcon(linkType: ResourceLinkType | string): ResourceIconInfo {
  switch (linkType) {
    case "figma":
      return {
        src: figmaIcon,
        alt: "Figma",
        className: "--figma",
      };
    case "notion":
      return {
        src: notionIcon,
        alt: "Notion",
        className: "--notion",
      };
    case "github_issue":
    case "github_pr":
      return {
        src: githubIcon,
        alt: "GitHub",
        className: "--github",
      };
    default:
      return {
        src: linkIcon,
        alt: "Link",
        className: "--url",
      };
  }
}

// Export individual icons for direct use if needed
export { figmaIcon, githubIcon, notionIcon, linkIcon };
