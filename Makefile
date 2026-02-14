.PHONY: stable-tag

stable-tag:
	@latest=$$(git tag --list 'stable-v*' | sort -V | tail -1); \
	if [ -z "$$latest" ]; then \
		echo "No stable-v* tags found. Creating stable-v1.0.0"; \
		git tag stable-v1.0.0; \
	else \
		major=$$(echo $$latest | sed 's/stable-v\([0-9]*\)\.\([0-9]*\)\.\([0-9]*\)/\1/'); \
		minor=$$(echo $$latest | sed 's/stable-v\([0-9]*\)\.\([0-9]*\)\.\([0-9]*\)/\2/'); \
		new_minor=$$((minor + 1)); \
		new_tag="stable-v$$major.$$new_minor.0"; \
		echo "Latest: $$latest -> New: $$new_tag"; \
		git tag $$new_tag; \
	fi
