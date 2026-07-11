# Product — Target Audience & Value

Derived from [`Requirement.md`](../Requirement.md).

---

## Hackathon context

This is a **CSE hackathon** project. Success is measured by:

1. Innovation and Creativity  
2. Technical Complexity and Completeness  
3. User Experience and Design  
4. Practicality and Usability  
5. Presentation and Pitch  
6. Team Collaboration  

---

## Problem

Users send inefficient prompts to AI:

- Vague filler, politeness, redundant constraints → worse answers and wasted tokens  
- No feedback on whether a prompt is “good”  
- Past chats hide repeated bad habits  

## Value proposition

**PromptLens** makes prompting measurable and improvable:

| For | Value |
|-----|--------|
| Students / hackers | Higher-quality answers; clearer asks |
| Builders | Tighter prompts before agent/API calls |
| Judges (demo) | Clear before/after scores and live Improve |

**Promise:** *See what’s wrong with your prompting style, get a 0–100 score, and fix it with a cheap model before you hit the expensive one.*

---

## Key features (MVP)

1. **Pre-send efficiency** — suggestions + optional Improve rewrite.  
2. **History analysis** — collect prior contexts; surface inefficiencies.  
3. **Score 0–100** — current prompt quality (plus output score after call).  
4. **Cheap processing models** — coaching on efficient models only.

## Explicitly out of scope (MVP)

- Middleware that strips low-information tokens from context before the call  
- Browser extension (stretch)  
- Multi-tenant SaaS  

---

## In scope (MVP)

- Import/analyze history  
- InputScore 0–100 with explanations  
- Style report  
- Improve toggle  
- Call target model + basic OutputScore  
- Local web UI + OpenAI-compatible proxy  

---

## Success for demo

- Score moves meaningfully after Improve  
- Style report names 2–3 personal anti-patterns  
- Pitch ties features to marking criteria  
