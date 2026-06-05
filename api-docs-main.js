// Language tab switcher — scoped per code block
    document.querySelectorAll('.code-block.tabbed').forEach(block => {
        const tabs   = block.querySelectorAll('.lang-tab');
        const panels = block.querySelectorAll('.lang-panel');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const lang = tab.dataset.lang;
                tabs.forEach(t   => t.classList.toggle('active',   t.dataset.lang === lang));
                panels.forEach(p => p.classList.toggle('active', p.dataset.lang === lang));
            });
        });
    });

    // Sidebar scroll highlight
    const sections = document.querySelectorAll('.doc-section');
    const navLinks = document.querySelectorAll('.doc-nav-link');
    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                navLinks.forEach(l => l.classList.remove('active'));
                const link = document.querySelector(`.doc-nav-link[href="#${entry.target.id}"]`);
                if (link) link.classList.add('active');
            }
        });
    }, { rootMargin: '-15% 0px -75% 0px' });
    sections.forEach(s => observer.observe(s));