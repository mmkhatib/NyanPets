#!/usr/bin/env ruby
# Writes NyanPets.xcodeproj with a macOS and an iOS app target.
#
#   gem install xcodeproj
#   ruby tools/make_xcodeproj.rb
#
# Run it again after adding or removing source files.
require 'xcodeproj'

ROOT = File.expand_path('..', __dir__)
PATH = File.join(ROOT, 'NyanPets.xcodeproj')
VERSION = File.read(File.join(ROOT, 'nyanpets.user.js'), encoding: 'UTF-8')[%r{//\s*@version\s+(\S+)}, 1] || '1.0'

project = Xcodeproj::Project.new(PATH)
project.root_object.attributes['LastUpgradeCheck'] = '1600'
project.root_object.attributes['BuildIndependentTargetsInParallel'] = 'YES'

main = project.main_group
userscript = main.new_file('nyanpets.user.js')
apps = main.new_group('apps', 'apps')
shared = apps.new_group('Shared', 'Shared')
mac = apps.new_group('macOS', 'macOS')
ios = apps.new_group('iOS', 'iOS')

shared_swift = shared.new_file('NyanScripts.swift')
host_js = shared.new_file('nyan-host.js')
assets = shared.new_file('Assets.xcassets')

mac_files = %w[NyanPetsMacApp.swift OverlayController.swift].map { |f| mac.new_file(f) }
mac_html = mac.new_file('overlay.html')
mac.new_file('Info.plist')

ios_files = %w[NyanPetsApp.swift PetBrowser.swift].map { |f| ios.new_file(f) }
ios_html = ios.new_file('playground.html')
ios.new_file('Info.plist')

COMMON = {
  'PRODUCT_NAME' => 'NyanPets',
  'MARKETING_VERSION' => VERSION,
  'CURRENT_PROJECT_VERSION' => '1',
  'SWIFT_VERSION' => '5.0',
  'CODE_SIGN_STYLE' => 'Automatic',
  'DEVELOPMENT_TEAM' => '',
  'GENERATE_INFOPLIST_FILE' => 'NO',
  'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME' => 'AccentColor',
  'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES',
  'SWIFT_EMIT_LOC_STRINGS' => 'NO',
}.freeze

def make_target(project, name, platform, deployment, settings, sources, resources)
  t = project.new_target(:application, name, platform, deployment)
  t.add_file_references(sources)
  t.add_resources(resources)
  t.build_configurations.each do |c|
    c.build_settings.merge!(COMMON).merge!(settings)
  end
  # Swift links Foundation and AppKit/UIKit on its own; the references the gem
  # adds point into one particular SDK version.
  t.frameworks_build_phase.files.to_a.each do |bf|
    ref = bf.file_ref
    bf.remove_from_project
    ref.remove_from_project if ref && ref.build_files.empty?
  end
  t.product_reference.path = 'NyanPets.app'
  t
end

mac_target = make_target(
  project, 'NyanPets macOS', :osx, '13.0',
  {
    'PRODUCT_BUNDLE_IDENTIFIER' => 'dev.nyanpets.mac',
    'INFOPLIST_FILE' => 'apps/macOS/Info.plist',
    'ASSETCATALOG_COMPILER_APPICON_NAME' => 'MacAppIcon',
    'CODE_SIGN_IDENTITY' => '-',
    'ENABLE_HARDENED_RUNTIME' => 'YES',
    'COMBINE_HIDPI_IMAGES' => 'YES',
  },
  mac_files + [shared_swift],
  [userscript, host_js, mac_html, assets]
)

ios_target = make_target(
  project, 'NyanPets iOS', :ios, '16.0',
  {
    'PRODUCT_BUNDLE_IDENTIFIER' => 'dev.nyanpets.ios',
    'INFOPLIST_FILE' => 'apps/iOS/Info.plist',
    'ASSETCATALOG_COMPILER_APPICON_NAME' => 'AppIcon',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'CODE_SIGN_IDENTITY' => 'iPhone Developer',
  },
  ios_files + [shared_swift],
  [userscript, host_js, ios_html, assets]
)

project.build_configurations.each do |c|
  c.build_settings['SWIFT_VERSION'] = '5.0'
  c.build_settings['CLANG_ENABLE_OBJC_ARC'] = 'YES'
end

{ '.js' => 'sourcecode.javascript', '.html' => 'text.html' }.each do |ext, type|
  project.files.select { |f| f.path.to_s.end_with?(ext) }.each { |f| f.last_known_file_type = type }
end
project.frameworks_group.remove_from_project if project.frameworks_group.children.empty?

project.sort_groups_first = false if project.respond_to?(:sort_groups_first=)
project.save

[mac_target, ios_target].each do |t|
  scheme = Xcodeproj::XCScheme.new
  scheme.configure_with_targets(t, nil, launch_target: true)
  scheme.save_as(PATH, t.name, true)
end
puts "Wrote #{PATH}"
