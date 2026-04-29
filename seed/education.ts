/**
 * Synthetic education and training entries (per spec lines 51-53: degree,
 * institution, year, field).
 */
import { prisma } from "@/lib/db";

type EducationSpec = {
  cwid: string;
  degree: string;
  institution: string;
  year: number;
  field?: string;
  externalId: string;
};

const education: EducationSpec[] = [
  // Jane Smith
  { cwid: "jas2001", degree: "PhD", institution: "Stanford University", year: 2008, field: "Cardiovascular Biology", externalId: "ASMS-JS-1" },
  { cwid: "jas2001", degree: "MD", institution: "Harvard Medical School", year: 2006, externalId: "ASMS-JS-2" },
  { cwid: "jas2001", degree: "BA", institution: "Yale University", year: 2000, field: "Molecular Biology", externalId: "ASMS-JS-3" },

  // Mary-Anne O'Brien
  { cwid: "mao2004", degree: "PhD", institution: "University of Oxford", year: 2007, field: "Neuroscience", externalId: "ASMS-MAO-1" },
  { cwid: "mao2004", degree: "MD", institution: "Trinity College Dublin", year: 2003, externalId: "ASMS-MAO-2" },

  // Li Ming
  { cwid: "lim2006", degree: "PhD", institution: "Memorial Sloan Kettering / Weill Cornell", year: 2005, field: "Cancer Biology", externalId: "ASMS-LM-1" },
  { cwid: "lim2006", degree: "MD", institution: "Peking Union Medical College", year: 2001, externalId: "ASMS-LM-2" },
  { cwid: "lim2006", degree: "BS", institution: "Tsinghua University", year: 1996, field: "Biology", externalId: "ASMS-LM-3" },

  // Sarah Johnson
  { cwid: "sjo2008", degree: "PhD", institution: "MIT", year: 2010, field: "Genetics", externalId: "ASMS-SJ-1" },
  { cwid: "sjo2008", degree: "MD", institution: "Columbia University", year: 2010, externalId: "ASMS-SJ-2" },
  { cwid: "sjo2008", degree: "BS", institution: "University of Chicago", year: 2002, field: "Biochemistry", externalId: "ASMS-SJ-3" },

  // Diana Patel
  { cwid: "dpa2010", degree: "MD", institution: "Weill Cornell Medical College", year: 2012, externalId: "ASMS-DP-1" },
  { cwid: "dpa2010", degree: "BS", institution: "University of Pennsylvania", year: 2007, field: "Bioengineering", externalId: "ASMS-DP-2" },

  // The lighter-touch scholars get one entry each.
  { cwid: "jod2002", degree: "MD", institution: "Johns Hopkins School of Medicine", year: 2008, externalId: "ASMS-JD-1" },
  { cwid: "mga2003", degree: "MD-PhD", institution: "University of Pennsylvania", year: 2014, field: "Infectious Disease Epidemiology", externalId: "ASMS-MJG-1" },
  { cwid: "ski2005", degree: "MD", institution: "University of Copenhagen", year: 2006, externalId: "ASMS-SK-1" },
  { cwid: "jho2011", degree: "MD", institution: "Yale School of Medicine", year: 2002, externalId: "ASMS-JH-1" },
  { cwid: "agr2012", degree: "MD", institution: "Mount Sinai School of Medicine", year: 2016, externalId: "ASMS-AG-1" },
];

export async function seedEducation() {
  for (const e of education) {
    await prisma.education.create({
      data: e,
    });
  }
}
