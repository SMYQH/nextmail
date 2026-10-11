import { SignButton } from "@/components/auth/sign-button"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import { LanguageSwitcher } from "@/components/layout/language-switcher"
import { Logo } from "@/components/ui/logo"

export function Header() {
  return (
    <header className="fluent-header fixed top-0 left-0 right-0 z-50 h-16">
      <div className="mx-auto h-full max-w-[1600px] px-4 lg:px-8">
        <div className="h-full flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-1 sm:gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
            <SignButton />
          </div>
        </div>
      </div>
    </header>
  )
}
